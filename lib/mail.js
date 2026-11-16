import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { convert } from 'html-to-text';
import { parseDocument, DomUtils } from 'htmlparser2';
import { canonicalAddress } from './runtime-utils.js';
export const maxMime = 24 * 1024 * 1024;
const maxBody = 2 * 1024 * 1024;
export const retrySchedule = [10, 30, 120, 600, 1800];
export class MailIssue extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export async function inboxBoundary(imap) {
    const mailbox = imap.mailbox;
    if (!mailbox || !mailbox.uidValidity)
        throw new MailIssue('mailbox_unavailable');
    const validity = String(mailbox.uidValidity);
    const next = Number(mailbox.uidNext);
    if (Number.isInteger(next) && next > 0)
        return { validity, next };
    if (mailbox.exists === 0)
        return { validity, next: 1, inferred: true };
    // Some 163 servers omit UIDNEXT from both EXAMINE and STATUS.
    // In sequence order the last live message has the highest live UID.
    const last = await imap.fetchOne('*', { uid: true });
    const current = imap.mailbox;
    if (!current || String(current.uidValidity) !== validity)
        throw new MailIssue('uidvalidity_changed');
    if (!last && current.exists === 0)
        return { validity, next: 1, inferred: true };
    if (!last || !Number.isInteger(last.uid) || last.uid < 1 || last.uid > 0xffffffff)
        throw new MailIssue('uidnext_unavailable');
    return { validity, next: last.uid + 1, inferred: true };
}
export async function findMail(store, page) {
    if (!Number.isSafeInteger(page.next) || page.next < 1)
        throw new MailIssue('uidnext_unavailable');
    const cursor = store.cursor();
    if (!cursor) {
        store.baseline(page.validity, page.next - 1);
        return;
    }
    if (cursor.validity !== page.validity) {
        store.reconcile(page.validity);
        return;
    }
    const reportedHigh = page.next - 1;
    if (reportedHigh < cursor.last_uid && !page.inferred)
        throw new MailIssue('uidnext_regressed');
    const high = Math.max(reportedHigh, cursor.last_uid);
    let start = cursor.last_uid + 1;
    while (start <= high) {
        const end = Math.min(start + 199, high);
        const rows = await page.fetch(start, end);
        store.enqueue(page.validity, end, rows);
        start = end + 1;
    }
    if (cursor.last_uid === high)
        store.enqueue(page.validity, high, []);
}
const blockedTags = new Set(['head', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'svg', 'img', 'video', 'audio', 'input']);
function hidden(el) {
    return blockedTags.has(el.name) || 'hidden' in el.attribs ||
        el.attribs['aria-hidden']?.toLowerCase() === 'true' ||
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(el.attribs.style ?? '');
}
export async function parseMail(source) {
    if (source.length > maxMime)
        throw new MailIssue('mime_too_large');
    const result = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    let text = result.text ?? '';
    if (!text.trim() && result.html) {
        const tree = parseDocument(result.html);
        for (const node of DomUtils.filter(node => node.type === 'tag' || node.type === 'script' || node.type === 'style', tree.children)) {
            if (hidden(node))
                DomUtils.removeElement(node);
        }
        text = convert(DomUtils.getOuterHTML(tree.children), { wordwrap: false, selectors: [
                { selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } }
            ] });
    }
    if (Buffer.byteLength(text) > maxBody)
        throw new MailIssue('body_too_large');
    const attachments = result.attachments.map(part => ({
        name: (part.filename || '附件').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240),
        size: part.size, type: part.contentType, data: part.content
    }));
    return {
        text,
        references: [...new Set([result.references ?? []].flat().filter(safeMessageId))],
        attachments
    };
}
const safeMessageId = (id) => /^<[^<>\s\x00-\x1f]+>$/.test(id);
function addresses(list, exclude = []) {
    const seen = new Set(exclude.map(x => x.toLowerCase()));
    return list.flatMap(value => {
        const canonical = canonicalAddress(value);
        if (!canonical || seen.has(canonical.toLowerCase()))
            return [];
        seen.add(canonical.toLowerCase());
        return [canonical];
    });
}
export function replyEnvelope(mail, body, account, text, all) {
    const validReply = addresses(mail.replyTo, [account]);
    const to = (validReply.length ? validReply : addresses(mail.from, [account])).slice(0, all ? undefined : 1);
    if (!to.length)
        throw new MailIssue('没有有效的回复地址');
    const cc = all ? addresses([...mail.to, ...mail.cc], [account, ...to]) : [];
    if (to.length + cc.length > 30)
        throw new MailIssue('回复收件人超过 30 人');
    const inReplyTo = mail.messageId && safeMessageId(mail.messageId) ? mail.messageId : undefined;
    const references = [...new Set([...body.references.filter(safeMessageId), ...(inReplyTo ? [inReplyTo] : [])])].slice(-30);
    const originalSubject = mail.subject.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/^(?:re:\s*)+/i, '').trim();
    return { from: account, to, cc, subject: 'Re: ' + originalSubject, text, inReplyTo, references };
}
export async function freezeMime(payload) {
    if (!payload.to.length || [payload.from, ...payload.to, ...payload.cc].some(value => canonicalAddress(value) !== value))
        throw new MailIssue('invalid_recipient_snapshot');
    const messageId = `<${randomUUID()}@${payload.from.split('@')[1]}>`;
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows',
        disableFileAccess: true, disableUrlAccess: true });
    const info = await transport.sendMail({ ...payload, messageId });
    return { raw: Buffer.from(info.message).toString('base64'), messageId };
}
function mailAuth(login) {
    const { user, password, accessToken, tokenFile } = login;
    if (tokenFile) {
        try {
            const handle = openSync(tokenFile, 'r');
            try {
                const stat = fstatSync(handle);
                if (!stat.isFile() || (stat.mode & 0o077) !== 0)
                    throw Error('invalid token file');
                const token = readFileSync(handle, 'utf8').trim();
                if (!token)
                    throw Error('empty token file');
                return { user, accessToken: token };
            }
            finally {
                closeSync(handle);
            }
        }
        catch {
            throw new MailIssue('mail_oauth_token_file_unavailable');
        }
    }
    return accessToken ? { user, accessToken } : { user, pass: password };
}
export class ImapSmtpMailbox {
    config;
    clients = new Set();
    transports = new Set();
    constructor(config) {
        this.config = config;
    }
    async smtp(operation) {
        const { host, port, secure, login } = this.config.smtp;
        const credentials = mailAuth(login);
        const auth = credentials.accessToken ? { ...credentials, type: 'OAuth2' } : credentials;
        const transport = nodemailer.createTransport({
            host, port, secure, requireTLS: !secure, auth,
            disableFileAccess: true, disableUrlAccess: true,
            connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 25_000, logger: false
        });
        this.transports.add(transport);
        try {
            return await operation(transport);
        }
        finally {
            transport.close();
            this.transports.delete(transport);
        }
    }
    async imap(operation) {
        const { host, port, secure, login } = this.config.imap;
        const imap = new ImapFlow({
            host, port, secure, doSTARTTLS: !secure, logger: false, disableAutoIdle: true,
            auth: mailAuth(login),
            clientInfo: { name: 'DSH Mail Assistant', version: '0.1.0' },
            connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 25_000
        });
        this.clients.add(imap);
        imap.on('error', () => { });
        try {
            await imap.connect();
            return await operation(imap);
        }
        catch (error) {
            if (error instanceof MailIssue)
                throw error;
            const detail = error;
            if (detail.authenticationFailed || detail.serverResponseCode === 'AUTHENTICATIONFAILED')
                throw new MailIssue('imap_auth_failed');
            throw new MailIssue('imap_request_failed');
        }
        finally {
            imap.close();
            this.clients.delete(imap);
        }
    }
    close() {
        for (const imap of this.clients)
            imap.close();
        for (const transport of this.transports)
            transport.close();
    }
    async inbox(fn) {
        return this.imap(async (imap) => {
            const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
            try {
                const selected = imap.mailbox;
                if (!selected || !selected.uidValidity)
                    throw new MailIssue('mailbox_unavailable');
                return await fn(imap, String(selected.uidValidity));
            }
            finally {
                lock.release();
            }
        });
    }
    scan(store) {
        return this.inbox(async (imap) => findMail(store, {
            ...await inboxBoundary(imap), fetch: (start, end) => fetchEnvelopes(imap, `${start}:${end}`, uid => uid >= start && uid <= end)
        }));
    }
    reconcile(store, after) {
        return this.inbox(async (imap) => {
            if (!Number.isFinite(after) || after > Date.now())
                throw new MailIssue('无效的核对起始时间');
            const meta = await inboxBoundary(imap);
            if (store.cursor()?.reconcile !== meta.validity)
                throw new MailIssue('没有匹配的待核对 UIDVALIDITY');
            const uids = await imap.search({ since: new Date(after - 86_400_000) }, { uid: true });
            if (!uids)
                throw new MailIssue('imap_search_failed');
            const batch = [];
            for (let i = 0; i < uids.length; i += 200) {
                const page = uids.slice(i, i + 200).sort((a, b) => a - b);
                const wanted = new Set(page);
                // Sparse results should not force fetching all intermediate UIDs.
                batch.push(...await fetchEnvelopes(imap, page, uid => wanted.has(uid) && uid < meta.next));
            }
            store.resetAfterReview(meta.validity, meta.next - 1, after, batch);
        });
    }
    read(mail) {
        return this.inbox(async (imap, validity) => {
            if (validity !== mail.validity)
                throw new MailIssue('uidvalidity_changed');
            if (mail.size > maxMime)
                throw new MailIssue('mime_too_large');
            const row = await imap.fetchOne(String(mail.uid), { source: { start: 0, maxLength: maxMime + 1 }, size: true }, { uid: true });
            if (!row || !row.source)
                throw new MailIssue('unavailable');
            if ((row.size ?? 0) > row.source.length || row.source.length > maxMime)
                throw new MailIssue('mime_too_large');
            return parseMail(row.source);
        });
    }
    async verify() {
        const folders = await this.imap(imap => imap.list());
        await this.smtp(transport => transport.verify());
        return folders.filter(folder => folder.specialUse === '\\Sent').map(folder => folder.path);
    }
    async send(payload, raw) {
        try {
            const response = await this.smtp(transport => transport.sendMail({
                envelope: { from: payload.from, to: [...payload.to, ...payload.cc] },
                raw: Buffer.from(raw, 'base64')
            }));
            const accepted = response.accepted.map(String);
            const rejected = response.rejected.map(String);
            return {
                status: accepted.length ? (rejected.length ? 'PARTIAL' : 'ACCEPTED') : 'UNKNOWN',
                accepted, rejected
            };
        }
        catch (error) {
            if (error instanceof MailIssue)
                return { status: 'FAILED_BEFORE_SUBMIT', accepted: [], rejected: [], code: error.code };
            const e = error;
            return smtpFailure(e);
        }
    }
    async saveCopy(raw, messageId) {
        const sentFolder = this.config.sentFolder;
        if (!sentFolder)
            throw new MailIssue('sent_folder_unconfigured');
        await this.imap(async (imap) => {
            const lock = await imap.getMailboxLock(sentFolder, { readOnly: true });
            try {
                const matches = await imap.search({ header: { 'message-id': messageId } }, { uid: true });
                if (!matches)
                    throw new MailIssue('sent_search_failed');
                if (matches.length)
                    return;
                const result = await imap.append(sentFolder, Buffer.from(raw, 'base64'), ['\\Seen']);
                if (!result)
                    throw new MailIssue('sent_append_failed');
            }
            finally {
                lock.release();
            }
        });
    }
}
export async function fetchEnvelopes(imap, range, include) {
    const rows = new Map();
    for await (const row of imap.fetch(range, { envelope: true, size: true, internalDate: true }, { uid: true })) {
        if (!include(row.uid) || !(row.envelope || row.internalDate || row.size !== undefined))
            continue;
        const prior = rows.get(row.uid);
        rows.set(row.uid, {
            envelope: row.envelope ?? prior?.envelope,
            internalDate: row.internalDate ?? prior?.internalDate,
            size: row.size ?? prior?.size
        });
    }
    return [...rows].map(([uid, row]) => {
        if (!row.envelope || !row.internalDate)
            throw new MailIssue('envelope_unavailable');
        const received = new Date(row.internalDate).getTime();
        if (!Number.isFinite(received))
            throw new MailIssue('invalid_internaldate');
        const { subject, from, replyTo, to, cc, messageId } = row.envelope;
        const values = (list) => list?.flatMap(item => item.address ? [item.address] : []) ?? [];
        return { uid, received, size: row.size ?? 0, subject: subject ?? '(无主题)',
            from: values(from), replyTo: values(replyTo), to: values(to), cc: values(cc), messageId };
    });
}
export function smtpFailure(error) {
    const cmd = error.command ?? '';
    const status = Number(error.responseCode);
    const rejected = error.code === 'EMESSAGE' && /^DATA(?:\b|$)/i.test(cmd) &&
        Number.isInteger(status) && status >= 400 && status < 600;
    const beforeData = ['EAUTH', 'EENVELOPE'].includes(error.code ?? '') ||
        /^(?:AUTH\b|EHLO\b|HELO\b|MAIL FROM\b|RCPT TO\b)/i.test(cmd);
    return { status: rejected || beforeData ? 'FAILED_BEFORE_SUBMIT' : 'UNKNOWN', accepted: [], rejected: [],
        code: error.code === 'EAUTH' ? 'SMTP_AUTH' : (rejected || beforeData) && status >= 400 ? 'SMTP ' + status : undefined };
}

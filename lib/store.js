import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const day = 86_400_000;
export const hash = (data) => createHash('sha256').update(data).digest('hex');
const json = JSON.stringify;
const parse = (value) => JSON.parse(String(value));
export class Store {
    db;
    lock;
    closed = false;
    constructor(path) {
        this.lock = new DatabaseSync(path + '.lock');
        try {
            this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
        }
        catch {
            this.lock.close();
            throw Error('已有邮件助手实例持有数据库锁');
        }
        this.db = new DatabaseSync(path);
        try {
            this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
            const version = Number(this.get('PRAGMA user_version')?.user_version);
            if (version > 4)
                throw Error('SQLite 版本高于本程序支持的版本');
            if (!version)
                this.tx(() => {
                    this.db.exec(readFileSync(new URL('../migrations/001.sql', import.meta.url), 'utf8'));
                    this.db.exec('PRAGMA user_version=1');
                });
            if (version < 2)
                this.tx(() => {
                    this.db.exec(readFileSync(new URL('../migrations/002.sql', import.meta.url), 'utf8'));
                    this.db.exec('PRAGMA user_version=2');
                });
            if (version < 3)
                this.tx(() => {
                    this.db.exec(readFileSync(new URL('../migrations/003.sql', import.meta.url), 'utf8'));
                    this.db.exec('PRAGMA user_version=3');
                });
            if (version < 4)
                this.tx(() => {
                    this.db.exec(readFileSync(new URL('../migrations/004.sql', import.meta.url), 'utf8'));
                    this.db.exec('PRAGMA user_version=4');
                });
            this.tx(() => {
                this.run("UPDATE notices SET state='unknown', issue='进程中断' WHERE state='sending'");
                this.run("UPDATE sends SET copy='unknown' WHERE copy='saving'");
                for (const row of this.all("SELECT draft, version FROM sends WHERE state='SENDING'")) {
                    this.finishSend(this.draft(Number(row.draft), Number(row.version)), {
                        status: 'UNKNOWN', accepted: [], rejected: [], code: '进程中断'
                    });
                }
            });
        }
        catch (error) {
            this.close();
            throw error;
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.db.close();
        }
        finally {
            this.lock.close();
        }
    }
    run(sql, ...values) { return this.db.prepare(sql).run(...values); }
    get(sql, ...values) { return this.db.prepare(sql).get(...values); }
    all(sql, ...values) { return this.db.prepare(sql).all(...values); }
    tx(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = fn();
            this.db.exec('COMMIT');
            return value;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    getSetting(key) {
        const value = this.get('SELECT value FROM settings WHERE key=?', key)?.value;
        return value === undefined ? undefined : String(value);
    }
    setSetting(key, value) {
        this.run('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
    }
    bind(account, app, owner) {
        this.tx(() => {
            for (const [key, value] of Object.entries({ account: account.toLowerCase(), app, owner })) {
                if (!value)
                    continue;
                const current = this.getSetting(key);
                if (current && current !== hash(value))
                    throw Error('账号绑定已变化，请为新账号使用独立数据库');
                this.setSetting(key, hash(value));
            }
        });
    }
    audit(action, ref, result) {
        this.run('INSERT INTO audit(ts,action,ref,result) VALUES (?,?,?,?)', Date.now(), action, ref, result);
    }
    cursor() { return this.get('SELECT * FROM cursor WHERE id=1'); }
    baseline(validity, high) {
        this.run('INSERT INTO cursor VALUES (1,?,?,?,NULL,?)', validity, high, Date.now(), Date.now());
    }
    reconcile(validity) {
        const previous = this.cursor();
        this.tx(() => {
            this.run('UPDATE cursor SET reconcile=? WHERE id=1', validity);
            if (previous?.reconcile !== validity) {
                this.audit('imap_uidvalidity', validity, 'reconciliation_required');
                this.queueNotice('imap/reconcile/' + validity, null, '163 邮箱 UIDVALIDITY 已变化，扫描暂停。请在本机核对后运行恢复命令。');
            }
        });
    }
    resetAfterReview(validity, high, after, batch) {
        if (this.cursor()?.reconcile !== validity)
            throw Error('邮箱没有匹配的待核对 UIDVALIDITY');
        this.tx(() => {
            const matches = new Map();
            for (const row of this.all('SELECT id,envelope FROM mails WHERE received>=? ORDER BY id DESC', after)) {
                const key = fingerprint(parse(row.envelope));
                const ids = matches.get(key) ?? [];
                ids.push(Number(row.id));
                matches.set(key, ids);
            }
            for (const item of [...batch].sort((a, b) => a.uid - b.uid)) {
                if (item.received < after)
                    continue;
                const id = matches.get(fingerprint(item))?.pop();
                if (id === undefined)
                    this.insertMail(validity, item);
                else
                    this.run(`UPDATE mails SET validity=?,uid=?,envelope=?,
            status=CASE WHEN status='uidvalidity_changed' THEN 'waiting' ELSE status END,
            attempts=CASE WHEN status='uidvalidity_changed' THEN 0 ELSE attempts END,
            next_at=CASE WHEN status='uidvalidity_changed' THEN 0 ELSE next_at END,
            issue=CASE WHEN status='uidvalidity_changed' THEN NULL ELSE issue END
            WHERE id=?`, validity, item.uid, json(item), id);
            }
            this.run('UPDATE cursor SET validity=?,last_uid=?,reconcile=NULL,scan_at=? WHERE id=1', validity, high, Date.now());
            this.audit('imap_reconciled', validity, 'since ' + new Date(after).toISOString());
        });
    }
    insertMail(validity, item) {
        this.run('INSERT OR IGNORE INTO mails(uuid,validity,uid,received,envelope) VALUES (?,?,?,?,?)', randomUUID(), validity, item.uid, item.received, json(item));
    }
    enqueue(validity, high, items) {
        this.tx(() => {
            const current = this.cursor();
            if (!current || current.validity !== validity || high < current.last_uid)
                throw Error('IMAP 高水位不匹配');
            for (const item of items) {
                if (item.uid > current.last_uid && item.uid <= high)
                    this.insertMail(validity, item);
            }
            this.run('UPDATE cursor SET last_uid=?,reconcile=NULL,scan_at=? WHERE id=1', high, Date.now());
        });
    }
    recent(limit = 10) { return this.all('SELECT * FROM mails WHERE ignored=0 ORDER BY id DESC LIMIT ?', limit).map(toMail); }
    mail(id) { const row = this.get('SELECT * FROM mails WHERE id=?', id); return row && toMail(row); }
    ignore(id) {
        this.tx(() => {
            this.run('UPDATE mails SET ignored=1 WHERE id=?', id);
            this.run("UPDATE notices SET state='ignored' WHERE mail=? AND key LIKE 'mail/%' AND state='queued'", id);
        });
    }
    nextMail() {
        const row = this.get("SELECT * FROM mails WHERE status='waiting' AND next_at<=? ORDER BY id LIMIT 1", Date.now());
        return row && toMail(row);
    }
    saveBody(id, body) {
        const attachments = body.attachments.map(({ name, size, type, extraction }) => ({ name, size, type, extraction }));
        this.run('UPDATE mails SET body=? WHERE id=?', json({ ...body, attachments }), id);
    }
    deferMail(mail, issue, terminal = false) {
        const delay = [10, 30, 120, 600, 1800][mail.attempts];
        const state = terminal ? issue : delay === undefined ? 'failed' : 'waiting';
        this.run('UPDATE mails SET attempts=attempts+1,status=?,issue=?,next_at=? WHERE id=?', state, issue, Date.now() + (delay ?? 0) * 1000, mail.id);
    }
    retryMail(id) {
        return this.run(`UPDATE mails SET status='waiting',attempts=0,next_at=0 WHERE id=?
      AND (status IN ('failed','waiting') OR (status='ready' AND summary_markdown IS NULL AND translation IS NULL))`, id).changes > 0;
    }
    cache(id, key) {
        const row = this.get('SELECT value FROM analysis_cache WHERE mail=? AND key=?', id, key);
        return row && parse(row.value);
    }
    putCache(id, key, value) {
        this.run('INSERT OR REPLACE INTO analysis_cache VALUES (?,?,?)', id, key, json(value));
    }
    completeMail(id, summary) {
        this.tx(() => {
            this.run("UPDATE mails SET status='ready',summary_markdown=?,issue=NULL WHERE id=?", summary, id);
            this.setSetting('last_model', String(Date.now()));
            if (this.get('SELECT ignored FROM mails WHERE id=?', id)?.ignored)
                return;
            this.queueNotice('mail/' + id, id, summary, undefined, true);
        });
    }
    saveOverview(id, summary) {
        this.tx(() => {
            this.run('UPDATE mails SET summary_markdown=? WHERE id=?', summary, id);
            this.run("UPDATE notices SET text=?,is_markdown=1 WHERE key=? AND state='queued'", summary, 'mail/' + id);
        });
    }
    saveOriginalTranslation(id, translation, replace = false) {
        this.run(`UPDATE mails SET original_translation=? WHERE id=?
      AND (? OR original_translation IS NULL)`, translation, id, Number(replace));
    }
    queueNotice(key, mail, text, fileName, markdown = false) {
        this.run(`INSERT OR IGNORE INTO notices(key,mail,text,file_name,touched,is_markdown)
      VALUES (?,?,?,?,?,?)`, key, mail, text, fileName ?? null, Date.now(), Number(markdown));
    }
    nextNotice() {
        return this.get(`SELECT n.* FROM notices n WHERE n.state='queued' AND n.next_at<=?
      AND (n.file_name IS NULL OR EXISTS
        (SELECT 1 FROM notices s WHERE s.key='mail/' || n.mail AND s.state='accepted'))
      ORDER BY n.touched,n.rowid LIMIT 1`, Date.now());
    }
    claimNotice(notice, now) {
        return this.run("UPDATE notices SET state='sending',attempts=attempts+1,touched=? WHERE key=? AND state='queued'", now, notice.key).changes > 0;
    }
    finishNotice(notice, state, issue, platformId, retryMs = 0, platformRef) {
        this.tx(() => {
            this.run('UPDATE notices SET state=?,issue=?,platform_id=?,platform_ref=?,next_at=? WHERE key=?', state, issue ?? null, platformId ?? null, platformRef ?? null, Date.now() + retryMs, notice.key);
            if (notice.file_name && ['failed', 'unknown'].includes(state))
                this.queueNotice(notice.key + '/fallback', notice.mail, `M${notice.mail} 的 TXT ${state === 'unknown' ? '投递结果不明' : '投递失败'}。可以在 QQ 索取全文。`);
        });
    }
    noticeBudget(now, midnight) {
        const count = (since) => Number(this.get('SELECT COUNT(*) AS count FROM notices WHERE attempts>0 AND touched>=?', since)?.count);
        return { minute: count(now - 60_000), day: count(midnight) };
    }
    quoted(platformId) {
        return Number(this.get(`SELECT mail FROM notices WHERE (platform_id=? OR platform_ref=?) AND mail IS NOT NULL
      ORDER BY touched DESC, rowid DESC LIMIT 1`, platformId, platformId)?.mail ?? 0) || undefined;
    }
    latestDeliveredMail() {
        return this.get(`SELECT n.mail AS id,n.touched FROM notices n JOIN mails m ON m.id=n.mail
      WHERE n.state='accepted' AND n.key='mail/' || n.mail AND m.ignored=0
      ORDER BY n.touched DESC,n.rowid DESC LIMIT 1`);
    }
    selectMail(id, receivedAt) {
        this.tx(() => {
            this.setSetting('selected_mail', String(id));
            this.setSetting('selected_mail_at', String(receivedAt));
        });
    }
    noticesForMail(id) {
        return this.all('SELECT key,state,issue FROM notices WHERE mail=? ORDER BY rowid DESC LIMIT 6', id);
    }
    rememberEvent(event) {
        return this.run('INSERT OR IGNORE INTO inbound_events VALUES (?,?)', event, Date.now()).changes > 0;
    }
    insertDraft(id, version, mail, payload) {
        const serialized = json(payload);
        this.run('INSERT INTO drafts(id,version,mail,created,payload,hash) VALUES (?,?,?,?,?,?)', id, version, mail, Date.now(), serialized, hash(serialized));
        return this.draft(id, version);
    }
    createDraft(mail, payload) {
        return this.tx(() => {
            const id = Number(this.get('SELECT coalesce(max(id),0)+1 AS id FROM drafts')?.id);
            return this.insertDraft(id, 1, mail, payload);
        });
    }
    draft(id, version) {
        const row = this.get('SELECT * FROM drafts WHERE id=? AND version=?', id, version);
        return row && toDraft(row);
    }
    latestDraft(id) {
        const row = this.get('SELECT * FROM drafts WHERE id=? ORDER BY version DESC LIMIT 1', id);
        return row && toDraft(row);
    }
    draftsForMail(mail) {
        return this.all(`SELECT d.* FROM drafts d WHERE d.mail=?
      AND d.version=(SELECT max(version) FROM drafts WHERE id=d.id)
      AND d.state IN ('DRAFT','AWAITING_CONFIRMATION') ORDER BY d.id DESC`, mail).map(toDraft);
    }
    reviseDraft(draft, payload) {
        return this.tx(() => {
            if (!this.editable(draft))
                throw Error('草稿已更新或已进入发送流程');
            this.run("UPDATE drafts SET state='SUPERSEDED' WHERE id=? AND version=?", draft.id, draft.version);
            this.run('DELETE FROM confirmations WHERE draft=? AND version=?', draft.id, draft.version);
            return this.insertDraft(draft.id, draft.version + 1, draft.mail, payload);
        });
    }
    editable(draft) {
        const latest = this.latestDraft(draft.id);
        return latest?.version === draft.version && latest.hash === draft.hash &&
            ['DRAFT', 'AWAITING_CONFIRMATION'].includes(latest.state);
    }
    showConfirmation(draft, who, now) {
        return this.tx(() => {
            if (!this.editable(draft))
                return false;
            this.run(`INSERT OR REPLACE INTO confirmations(draft,version,hash,owner,chat,preview_event,expires,token_hash,used,previewed)
        VALUES (?,?,?,?,?,?,?,?,NULL,?)`, draft.id, draft.version, draft.hash, who.owner, who.chat, who.event, now + 30 * day, hash(randomUUID()), now);
            this.run("UPDATE drafts SET state='AWAITING_CONFIRMATION' WHERE id=? AND version=?", draft.id, draft.version);
            this.audit('preview', `D${draft.id} v${draft.version}`, 'delivered');
            return true;
        });
    }
    hasPreview(draft, who) {
        return Boolean(this.get(`SELECT 1 FROM confirmations WHERE draft=? AND version=? AND hash=?
      AND owner=? AND chat=? AND used IS NULL`, draft.id, draft.version, draft.hash, who.owner, who.chat));
    }
    approve(draft, who, now) {
        return this.tx(() => {
            if (!this.editable(draft))
                return false;
            const updated = this.run(`UPDATE confirmations SET used=? WHERE draft=? AND version=? AND hash=?
        AND owner=? AND chat=? AND preview_event<>? AND used IS NULL
        AND previewed<? AND (? IS NULL OR ? >= (previewed / 1000) * 1000)`, now, draft.id, draft.version, draft.hash, who.owner, who.chat, who.event, who.receivedAt ?? now, who.qqSentAt ?? null, who.qqSentAt ?? null);
            if (!updated.changes)
                return false;
            this.enqueueSend(draft, now);
            return true;
        });
    }
    approveDirect(draft, now) {
        return this.tx(() => {
            if (draft.version !== 1 || !this.editable(draft))
                return false;
            this.enqueueSend(draft, now);
            return true;
        });
    }
    enqueueSend(draft, now) {
        this.run('INSERT INTO sends(draft,version,touched) VALUES (?,?,?)', draft.id, draft.version, now);
        this.run("UPDATE drafts SET state='QUEUED' WHERE id=? AND version=?", draft.id, draft.version);
        this.audit('approve', `D${draft.id} v${draft.version}`, 'queued');
    }
    cancel(draft) {
        return this.tx(() => {
            const result = this.run(`UPDATE drafts SET state='CANCELLED' WHERE id=? AND version=?
        AND state IN ('DRAFT','AWAITING_CONFIRMATION','QUEUED')`, draft.id, draft.version);
            if (!result.changes)
                return false;
            this.run('DELETE FROM confirmations WHERE draft=? AND version=?', draft.id, draft.version);
            this.run("UPDATE sends SET state='CANCELLED',touched=? WHERE draft=? AND version=? AND state='QUEUED'", Date.now(), draft.id, draft.version);
            this.audit('cancel', `D${draft.id} v${draft.version}`, 'cancelled');
            return true;
        });
    }
    nextSend() {
        const row = this.get("SELECT draft,version FROM sends WHERE state='QUEUED' ORDER BY touched LIMIT 1");
        return row && this.draft(Number(row.draft), Number(row.version));
    }
    claimSend(draft, raw, messageId) {
        return this.tx(() => {
            if (!this.run(`UPDATE sends SET state='SENDING',raw=?,message_id=?,touched=?
          WHERE draft=? AND version=? AND state='QUEUED'`, raw, messageId, Date.now(), draft.id, draft.version).changes)
                return false;
            this.run("UPDATE drafts SET state='SENDING' WHERE id=? AND version=?", draft.id, draft.version);
            return true;
        });
    }
    completeSend(draft, result, copy) {
        this.tx(() => this.finishSend(draft, result, copy));
    }
    finishSend(draft, result, copy) {
        if (!this.run(`UPDATE sends SET state=?,result=?,touched=?,copy=? WHERE draft=? AND version=?
      AND state IN ('QUEUED','SENDING')`, result.status, json(result), Date.now(), copy ?? null, draft.id, draft.version).changes)
            return;
        this.run('UPDATE drafts SET state=? WHERE id=? AND version=?', result.status, draft.id, draft.version);
        const details = result.status === 'PARTIAL' ? `\n接受 ${result.accepted.join(', ')}\n拒绝 ${result.rejected.join(', ')}` : '';
        const labels = { ACCEPTED: '163 已接受邮件', PARTIAL: '163 部分接受', UNKNOWN: 'SMTP 提交结果不明，请核对发件箱', FAILED_BEFORE_SUBMIT: 'SMTP 未成功提交' };
        this.queueNotice(`send/${draft.id}/${draft.version}`, draft.mail, `D${draft.id} v${draft.version} · ${labels[result.status]}${details}${result.code ? '\n' + result.code : ''}`);
        this.audit('smtp', `D${draft.id} v${draft.version}`, result.status);
    }
    nextCopy() {
        return this.get("SELECT draft,version,raw,message_id FROM sends WHERE copy='pending' ORDER BY touched LIMIT 1");
    }
    copyState(item, copy) {
        this.run('UPDATE sends SET copy=? WHERE draft=? AND version=?', copy, item.draft, item.version);
    }
    retryCopy(draft, version) {
        return this.run(`UPDATE sends SET copy='pending' WHERE draft=? AND version=?
      AND state='ACCEPTED' AND copy IN ('failed','unknown') AND raw IS NOT NULL`, draft, version).changes > 0;
    }
    retryNotice(key) {
        return this.run(`UPDATE notices SET state='queued',attempts=0,next_at=0
      WHERE key=? AND state='failed' AND text<>''`, key).changes > 0;
    }
    resumeNotifications() {
        this.tx(() => {
            this.setSetting('notifications_paused', '0');
            const waiting = this.all(`SELECT mail,key FROM notices WHERE state='queued'
        AND key='mail/' || mail ORDER BY mail`);
            if (waiting.length <= 10)
                return;
            for (let start = 0; start < waiting.length; start += 60) {
                const batch = waiting.slice(start, start + 60);
                const ids = batch.map(row => 'M' + row.mail);
                this.queueNotice(`digest/${batch[0].mail}/${batch.at(-1)?.mail}`, null, `通知暂停期间收到 ${batch.length} 封邮件
${ids.join('、')}
可发送「详情 M编号」或「全文 M编号」逐封查看。`);
            }
            for (const row of waiting) {
                this.run(`UPDATE notices SET state='digest' WHERE state='queued' AND key IN (?,?)`, String(row.key), String(row.key) + '/txt');
            }
        });
    }
    // Retain send results and deduplication keys even after sensitive payloads expire.
    purge(now = Date.now()) {
        this.tx(() => {
            this.run(`DELETE FROM analysis_cache WHERE mail IN
        (SELECT id FROM mails WHERE received<? AND status<>'waiting')`, now - 30 * day);
            this.run("UPDATE mails SET body=NULL,translation=NULL,summary_markdown=NULL,original_translation=NULL WHERE received<? AND status<>'waiting'", now - 30 * day);
            this.run("UPDATE notices SET text='' WHERE touched<? AND state<>'sending'", now - 30 * day);
            this.run("UPDATE notices SET state='expired' WHERE text='' AND state='queued'");
            this.run("UPDATE drafts SET state='EXPIRED',payload='{}' WHERE created<? AND state IN ('DRAFT','AWAITING_CONFIRMATION')", now - 30 * day);
            this.run("UPDATE drafts SET payload='{}' WHERE created<? AND state IN ('ACCEPTED','PARTIAL','FAILED_BEFORE_SUBMIT','CANCELLED','SUPERSEDED')", now - 30 * day);
            this.run("UPDATE sends SET raw=NULL WHERE touched<? AND state NOT IN ('UNKNOWN','QUEUED','SENDING') AND coalesce(copy,'') NOT IN ('pending','saving','unknown')", now - 30 * day);
            this.run(`DELETE FROM confirmations WHERE expires<? AND NOT EXISTS
        (SELECT 1 FROM drafts d WHERE d.id=confirmations.draft AND d.version=confirmations.version AND d.state='AWAITING_CONFIRMATION')`, now);
            this.run('DELETE FROM inbound_events WHERE received<?', now - 7 * day);
            this.run('DELETE FROM audit WHERE ts<?', now - 180 * day);
        });
    }
    health() {
        const count = (sql) => Number(this.get(sql)?.count);
        return {
            lastScan: this.cursor()?.scan_at ?? null,
            reconcile: this.cursor()?.reconcile ?? null,
            lastModel: Number(this.getSetting('last_model')) || null,
            pending: count("SELECT count(*) AS count FROM mails WHERE status='waiting'"),
            oldestPending: this.get("SELECT min(received) AS oldest FROM mails WHERE status='waiting'")?.oldest ?? null,
            failed: count("SELECT count(*) AS count FROM mails WHERE status NOT IN ('waiting','ready')"),
            qqPending: count("SELECT count(*) AS count FROM notices WHERE state='queued'"),
            qqFailed: count("SELECT count(*) AS count FROM notices WHERE state='failed'"),
            qqUnknown: count("SELECT count(*) AS count FROM notices WHERE state='unknown'"),
            smtpWaiting: count("SELECT count(*) AS count FROM sends WHERE state='QUEUED'"),
            smtpUnknown: count("SELECT count(*) AS count FROM sends WHERE state='UNKNOWN'"),
            smtpPartial: count("SELECT count(*) AS count FROM sends WHERE state='PARTIAL'"),
            sentCopyIssues: count("SELECT count(*) AS count FROM sends WHERE copy IN ('failed','unknown')")
        };
    }
}
function fingerprint(mail) {
    return hash(json([mail.messageId, mail.received, mail.subject, mail.from, mail.to, mail.size]));
}
function toMail(row) {
    return { ...parse(row.envelope), id: Number(row.id), validity: String(row.validity),
        status: String(row.status), issue: row.issue, attempts: Number(row.attempts),
        body: row.body ? parse(row.body) : null, translation: row.translation ? parse(row.translation) : null,
        summaryMarkdown: row.summary_markdown, originalTranslation: row.original_translation };
}
function toDraft(row) { return { ...row, payload: parse(row.payload) }; }

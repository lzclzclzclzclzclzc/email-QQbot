import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { canonicalAddress } from './runtime-utils.js';
const check = (valid, message) => { if (!valid)
    throw Error(message); };
function mailConnection(env, protocol, user, defaultHost) {
    const prefix = 'MAIL_' + protocol;
    const value = (key) => env[prefix + '_' + key]?.trim() ?? '';
    const hostInput = value('HOST') || defaultHost;
    const useIP = Boolean(isIP(hostInput));
    const host = useIP ? hostInput : domainToASCII(hostInput);
    check(!hostInput || useIP || (/^[a-z0-9.-]+$/i.test(host) && !/[\s\\/:@?#%]/.test(hostInput)), prefix + '_HOST 需要主机名或 IP 地址');
    const explicitPort = value('PORT');
    const port = Number(explicitPort);
    check(!explicitPort || (/^\d+$/.test(explicitPort) && port >= 1 && port <= 65535), prefix + '_PORT 无效');
    const configuredSecurity = value('SECURITY').toLowerCase();
    check(!configuredSecurity || ['tls', 'starttls'].includes(configuredSecurity), prefix + '_SECURITY 需为 tls 或 starttls');
    const starttlsPort = protocol === 'IMAP' ? 143 : 587;
    const secure = configuredSecurity ? configuredSecurity === 'tls' : port !== starttlsPort && (protocol !== 'SMTP' || port !== 25);
    const login = {
        user: value('USER') || user,
        password: env[prefix + '_PASSWORD'] || undefined,
        accessToken: value('ACCESS_TOKEN') || undefined,
        tokenFile: value('ACCESS_TOKEN_FILE') || undefined,
    };
    if (!login.password && !login.accessToken && !login.tokenFile) {
        login.password = env.MAIL_PASSWORD || env.MAIL_AUTH_CODE?.trim() || undefined;
        login.accessToken = env.MAIL_ACCESS_TOKEN?.trim() || undefined;
        login.tokenFile = env.MAIL_ACCESS_TOKEN_FILE?.trim() || undefined;
    }
    return { host, port: port || (secure ? (protocol === 'IMAP' ? 993 : 465) : starttlsPort), secure, login };
}
export function readConfig(env = process.env) {
    const word = (key) => env[key]?.trim() ?? '';
    const flag = (key) => word(key) === '1';
    const stateDir = resolve(word('DSH_MAIL_STATE') || resolve(homedir(), '.local/state/dsh-mail-assistant'));
    const providedUser = word('MAIL_USER');
    const user = canonicalAddress(providedUser) ?? '';
    check(!providedUser || Boolean(user), 'MAIL_USER 需要完整的邮箱地址');
    const is163 = /@163\.com$/i.test(user);
    const imap = mailConnection(env, 'IMAP', user, is163 ? 'imap.163.com' : '');
    const smtp = mailConnection(env, 'SMTP', user, is163 ? 'smtp.163.com' : '');
    const mailReady = Boolean(user && [imap, smtp].every(({ host, login }) => host && login.user &&
        (login.password || login.accessToken || login.tokenFile)));
    const config = {
        stateDir, live: flag('MAIL_LIVE'), user, imap, smtp, mailReady,
        owner: word('QQ_OWNER_OPENID'), appId: word('QQBOT_APPID'), appSecret: word('QQBOT_SECRET'),
        enroll: word('QQ_ENROLL_CODE'), healthPort: Number(word('DSH_MAIL_HEALTH_PORT') || 3081),
        sentFolder: word('MAIL_SENT_FOLDER') || undefined,
        modelProvider: word('DSH_MAIL_MODEL_PROVIDER'), modelName: word('DSH_MAIL_MODEL_NAME'),
        modelCallsDaily: Number(word('DSH_MAIL_MODEL_CALLS_DAILY') || 1000)
    };
    check(Boolean(config.owner) === /^[A-Za-z0-9_-]+$/.test(config.owner), 'QQ_OWNER_OPENID 格式无效');
    check(!config.enroll || /^[a-fA-F0-9]{32,64}$/.test(config.enroll), 'QQ_ENROLL_CODE 需要 32～64 位随机十六进制字符');
    check(!config.enroll || Boolean(config.appId && config.appSecret && !config.live && !config.owner), '绑定 QQ 前需要 AppID 和 Secret，且 MAIL_LIVE=0、QQ_OWNER_OPENID 为空');
    check(!config.live || mailReady, '启用 MAIL_LIVE 前请配置邮箱地址、IMAP 与 SMTP 主机和认证信息');
    check(!config.live || Boolean(config.owner && config.appId && config.appSecret), '启用 MAIL_LIVE 前请配置 QQ 机器人及所有者 OpenID');
    check(Boolean(config.modelProvider) === Boolean(config.modelName), '请同时填写模型 provider 和 model');
    check(Number.isInteger(config.healthPort) && config.healthPort >= 1024 && config.healthPort <= 65535, '健康页端口无效');
    check(Number.isInteger(config.modelCallsDaily) && config.modelCallsDaily > 0, '模型每日调用上限无效');
    return config;
}

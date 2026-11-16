#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
node=${1:-}
if [[ ${EUID} != 0 || ! -x $node ]]; then
  echo '用法：sudo bash deploy/install.sh /绝对路径/node24' >&2
  exit 2
fi
if [[ $(systemctl is-active dsh-mail.service || true) == active ]]; then
  echo '请先停止当前 dsh-mail.service，并保留数据库备份。' >&2
  exit 1
fi
if curl --max-time 1 -sS http://127.0.0.1:3081/health > /dev/null 2>&1; then
  echo '请先停止邮件助手前台进程。' >&2
  exit 1
fi
"$node" "$root/scripts/release.mjs" --verify
if ! getent passwd dshmail > /dev/null; then
  useradd --system --user-group --no-create-home --home-dir /var/lib/dsh-mail --shell /usr/sbin/nologin dshmail
fi
[[ $(id -u dshmail) != 0 ]] && getent group dshmail > /dev/null
install -d -m 0750 -o root -g dshmail /opt/dsh-mail /opt/dsh-mail/runtime /opt/dsh-mail/runtime/bin /opt/dsh-mail/mail-assistant
install -d -m 0700 -o dshmail -g dshmail /var/lib/dsh-mail /var/lib/dsh-mail/dsh /var/lib/dsh-mail/state /var/lib/dsh-mail/artifacts /srv/dsh-mail/workspace
install -d -m 0700 -o root -g root /etc/dsh-mail
if [[ ! -e /etc/dsh-mail/secrets.env ]]; then
  install -m 0600 "$root/deploy/secrets.env.example" /etc/dsh-mail/secrets.env
fi
if [[ -f /var/lib/dsh-mail/state/mail.sqlite ]]; then
  backup=$(date -u +%Y%m%dT%H%M%SZ).sqlite
  runuser -u dshmail -- env DSH_MAIL_STATE=/var/lib/dsh-mail/state \
    /opt/dsh-mail/runtime/bin/node /opt/dsh-mail/mail-assistant/scripts/admin.mjs \
      backup "/var/lib/dsh-mail/state/backups/$backup"
fi
release_stage=$(mktemp -d /opt/dsh-mail/.stage.XXXXXX)
cleanup() {
  local status=$?
  if (( status != 0 )) && [[ -d $release_stage/old ]]; then
    echo "发布切换失败，旧安装保存在 $release_stage/old，请按 README 恢复。" >&2
    return "$status"
  fi
  rm -rf -- "$release_stage"
}
trap cleanup EXIT
cp -a "$root/node_modules" "$release_stage/node_modules"
mkdir "$release_stage/application"
cp -a "$root/"{lib,migrations,scripts,deploy,package.json,package-lock.json,cordis.patch.yml,config.schema.json} "$release_stage/application"
install -m 0750 "$node" "$release_stage/node"
chown -R root:dshmail "$release_stage"
chmod -R u=rwX,g=rX,o= "$release_stage"
mkdir -m 0750 "$release_stage/old"
for path in /opt/dsh-mail/release.json /etc/systemd/system/dsh-mail.service; do
  if [[ -f $path ]]; then cp -a "$path" "$release_stage/old/${path##*/}"; fi
done
for path in /opt/dsh-mail/runtime/node_modules /opt/dsh-mail/runtime/bin/node /opt/dsh-mail/mail-assistant; do
  if [[ -e $path ]]; then mv -T "$path" "$release_stage/old/${path##*/}"; fi
done
mv -T "$release_stage/node_modules" /opt/dsh-mail/runtime/node_modules
mv -T "$release_stage/node" /opt/dsh-mail/runtime/bin/node
mv -T "$release_stage/application" /opt/dsh-mail/mail-assistant
ln -s ../runtime/node_modules /opt/dsh-mail/mail-assistant/node_modules
install -m 0640 -o root -g dshmail "$root/dist/release.json" /opt/dsh-mail/release.json
install -m 0644 "$root/deploy/dsh-mail.service" /etc/systemd/system/dsh-mail.service
systemctl daemon-reload
echo '已安装文件。请编辑 /etc/dsh-mail/secrets.env，再启动 dsh-mail.service。'

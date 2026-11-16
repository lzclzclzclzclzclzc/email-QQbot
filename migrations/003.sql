-- Older builds put the translation in a queued summary or its own TXT notice.
UPDATE notices
SET text = CASE
  WHEN instr(text, char(10) || char(10) || '中文全文' || char(10)) > 0
    THEN substr(text, 1, instr(text, char(10) || char(10) || '中文全文' || char(10)) - 1)
  ELSE replace(text, char(10) || '完整版以 TXT 投递，也可发送「全文 M' || mail || '」查阅。', '')
END
WHERE state = 'queued' AND key = 'mail/' || mail;

UPDATE notices
SET state = 'on_request'
WHERE key = 'mail/' || mail || '/txt' AND state = 'queued' AND file_name IS NOT NULL;

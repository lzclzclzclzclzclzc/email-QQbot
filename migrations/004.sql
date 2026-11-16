ALTER TABLE mails ADD COLUMN summary_markdown TEXT;
ALTER TABLE mails ADD COLUMN original_translation TEXT;
ALTER TABLE notices ADD COLUMN is_markdown INTEGER NOT NULL DEFAULT 0;

UPDATE mails SET original_translation = json_extract(translation, '$.text')
WHERE json_type(translation, '$.text') = 'text';

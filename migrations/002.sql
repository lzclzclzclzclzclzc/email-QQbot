ALTER TABLE confirmations ADD COLUMN previewed INTEGER NOT NULL DEFAULT 0;
DELETE FROM confirmations WHERE used IS NULL;
ALTER TABLE notices ADD COLUMN platform_ref TEXT;

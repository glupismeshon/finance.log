ALTER TABLE users ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX users_handle ON users(handle);

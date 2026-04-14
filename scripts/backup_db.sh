#!/bin/bash
# Автобэкап transcribe.db — запуск через cron
# Хранит 7 последних бэкапов

BACKUP_DIR="/opt/transcribe/backups/daily"
DB_PATH="/opt/transcribe/data/db/transcribe.db"
DATE=$(date +%Y-%m-%d_%H%M)

mkdir -p "$BACKUP_DIR"
cp "$DB_PATH" "$BACKUP_DIR/transcribe_${DATE}.db"

# Ротация — оставляем только 7 последних
ls -t "$BACKUP_DIR"/transcribe_*.db | tail -n +8 | xargs rm -f 2>/dev/null

echo "[$(date)] Backup OK: transcribe_${DATE}.db ($(du -h "$BACKUP_DIR/transcribe_${DATE}.db" | cut -f1))"

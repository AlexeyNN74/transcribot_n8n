#!/bin/bash
# rotate_runner_log.sh — ротация runner.log (хранит 7 дней)
# Cron: 0 4 * * * /opt/transcribe/app/scripts/rotate_runner_log.sh

LOG_DIR="/opt/transcribe/data/tasks"
LOG_FILE="$LOG_DIR/runner.log"
MAX_SIZE=1048576  # 1MB

# Проверяем размер файла
if [ ! -f "$LOG_FILE" ]; then
    exit 0
fi

FILE_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
if [ "$FILE_SIZE" -lt "$MAX_SIZE" ]; then
    exit 0
fi

# Ротация: .7 → удалить, .6 → .7, ... .1 → .2, current → .1
for i in 6 5 4 3 2 1; do
    next=$((i + 1))
    [ -f "$LOG_FILE.$i" ] && mv "$LOG_FILE.$i" "$LOG_FILE.$next"
done

mv "$LOG_FILE" "$LOG_FILE.1"
touch "$LOG_FILE"

# Удаляем старые (>7)
rm -f "$LOG_FILE.8" "$LOG_FILE.9" "$LOG_FILE.10" 2>/dev/null

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Log rotated (was ${FILE_SIZE} bytes)" >> "$LOG_FILE"

# Backup and Restore

This document covers backup and restore procedures for dnd.firegory data: the PostgreSQL database and the file storage directory.

## What to back up

dnd.firegory stores two categories of persistent data:

1. **PostgreSQL database** — all structured data: users, sessions, sources, files, ingestion jobs, documents, pages, chunks, embeddings, and diagnostic events.
2. **File storage** — original PDFs and processed artifacts (normalized PDFs, extracted text, OCR output, chunks).

Both must be backed up together for a consistent restore.

## Storage location

### Docker Compose deployment

| Data | Volume | Mount path |
| --- | --- | --- |
| PostgreSQL data | `postgres_data` | `/var/lib/postgresql/data` (inside postgres container) |
| Redis data | `redis_data` | `/data` (inside redis container) |
| File storage | `app_storage` | `/app/storage` (inside app/worker containers) |

Redis data is the job queue — it is transient and does not require backup. Jobs that were queued but not processed will be lost on restore; they can be retried through the admin UI.

### Bare-metal deployment

| Data | Default location |
| --- | --- |
| PostgreSQL data | Managed by PostgreSQL (varies by installation) |
| File storage | `./storage` (configurable via `STORAGE_ROOT`) |

## PostgreSQL backup

### Using pg_dump (recommended)

The most reliable way to back up PostgreSQL is `pg_dump`, which produces a consistent snapshot.

**From the host with Docker Compose**:

```bash
docker compose exec postgres pg_dump \
  -U dnd \
  -d dnd_firegory \
  --format=custom \
  --file=/var/lib/postgresql/data/backup.dump
```

Then copy the backup out of the volume:

```bash
docker cp dnd.firegory-postgres-1:/var/lib/postgresql/data/backup.dump ./backup-$(date +%Y%m%d).dump
```

Clean up the backup file from the container:

```bash
docker compose exec postgres rm /var/lib/postgresql/data/backup.dump
```

**From the host with bare-metal PostgreSQL**:

```bash
pg_dump -U dnd -d dnd_firegory --format=custom -f backup-$(date +%Y%m%d).dump
```

### Using pg_dumpall (full cluster backup)

For a complete PostgreSQL cluster backup including roles and tablespaces:

```bash
docker compose exec postgres pg_dumpall -U dnd > full-cluster-$(date +%Y%m%d).sql
```

### Scheduling with cron

Add to crontab for daily backups at 3 AM:

```cron
0 3 * * * docker compose -f /path/to/dnd.firegory/docker-compose.yml exec -T postgres pg_dump -U dnd -d dnd_firegory --format=custom > /backups/dnd-firegory-$(date +\%Y\%m\%d).dump
```

## File storage backup

### Docker Compose

The file storage lives in the `app_storage` named volume. Back it up with:

```bash
# Option 1: Tar the volume mount
docker run --rm -v dnd.firegory_app_storage:/data -v $(pwd):/backup alpine \
  tar czf /backup/storage-$(date +%Y%m%d).tar.gz -C /data .

# Option 2: Use docker cp if containers are running
docker cp dnd.firegory-app-1:/app/storage ./storage-backup-$(date +%Y%m%d)
```

### Bare-metal

```bash
tar czf storage-$(date +%Y%m%d).tar.gz -C /path/to/storage .
```

## Restore procedure

### 1. Stop services

```bash
docker compose down
# Keep volumes intact — do NOT use docker compose down -v
```

### 2. Restore PostgreSQL

```bash
# Start only PostgreSQL
docker compose up -d postgres

# Wait for it to be healthy
docker compose ps

# Restore from pg_dump custom format
docker compose exec -T postgres pg_restore \
  -U dnd \
  -d dnd_firegory \
  --clean \
  --if-exists \
  < backup-20260101.dump
```

For plain SQL backups:

```bash
docker compose exec -T postgres psql -U dnd -d dnd_firegory < full-cluster-20260101.sql
```

### 3. Restore file storage

```bash
docker run --rm -v dnd.firegory_app_storage:/data -v $(pwd):/backup alpine \
  sh -c "cd /data && tar xzf /backup/storage-20260101.tar.gz"
```

### 4. Start all services

```bash
docker compose up -d
```

### 5. Verify

1. Log in and check user list at `/admin/users`.
2. Browse sources at `/admin/ingestion` — uploaded files should appear.
3. Search for content from previously ingested PDFs.
4. Check that ingestion job history is intact.

## Backup retention recommendations

| Backup type | Frequency | Retention |
| --- | --- | --- |
| PostgreSQL | Daily | 30 days |
| File storage | Weekly | 90 days (or match PDF ingestion rate) |

## Notes

- **Embedding vectors** are stored in the `chunks.embedding` column (pgvector). They are included in the PostgreSQL dump. After restore, vector search works without re-ingesting.
- **Original PDFs** are in the file storage, not the database. Both must be restored together.
- **Redis queue state** is transient — unprocessed jobs are lost on restore. Use the admin UI retry action for any that were interrupted.
- **Soft-deleted records** are included in dumps by default. If you want to exclude them, use `--exclude-table-data` flags or filter during restore.

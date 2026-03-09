# Data Directory

This directory contains runtime data and configuration files.

## Configuration Files

### config.json (NOT in git)
The active configuration file containing sensitive information (API keys, secrets).

**Location**: `data/config.json`

**Important**: This file is excluded from git via `.gitignore` to protect sensitive data.

### config.json.backup (NOT in git)
Backup copy of the configuration file.

**Location**: `data/config.json.backup`

**Usage**:
```bash
# Restore from backup if config.json is lost
cp data/config.json.backup data/config.json
```

### config.json.template (IN git)
Template file with placeholder values for reference.

**Location**: `data/config.json.template`

**Usage**:
```bash
# Create new config from template
cp data/config.json.template data/config.json
# Then edit data/config.json with your actual values
```

## Database Files

- `sessions.db` - SQLite database for session management
- `*.db-*` - Database backup/journal files

## Runtime Files

- `evolclaw.pid` - Process ID file
- `stdout.log` - Standard output log
- `restart-pending.json` - Restart coordination file

## Backup Strategy

**Manual backup**:
```bash
# Backup config
cp data/config.json data/config.json.backup

# Backup database
cp data/sessions.db data/sessions.db.backup
```

**Restore**:
```bash
# Restore config
cp data/config.json.backup data/config.json

# Restore database
cp data/sessions.db.backup data/sessions.db
```

## Security Notes

- Never commit `config.json` or `config.json.backup` to git
- Keep backups in a secure location
- Rotate API keys regularly
- Use environment variables for CI/CD deployments

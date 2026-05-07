# Reminder Skill

Status: CURRENT (2026-04-14)

## Purpose

Provides natural language time parsing and todo/reminder management for the personal agent. Enables users to set reminders using everyday Chinese expressions like "晚上8点提醒我吃饭".

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User Message   │────▶│  TemporalParser  │────▶│   TodoManager   │
│  (Natural Lang) │     │  (Rule + LLM)    │     │  (CRUD + Check) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                           ┌──────────────────────────────┘
                           ▼
                    ┌──────────────────┐
                    │   reminder_check │
                    │   (Scheduler Job)│
                    └──────────────────┘
                           │
                           ▼
                    ┌──────────────────┐
                    │  Proactive Send  │
                    │  (WeChat/Channel)│
                    └──────────────────┘
```

## Components

### 1. TemporalParser (`src/personal_agent/temporal_parser.py`)

Parses natural language time expressions into ISO 8601 timestamps.

**Supported Patterns:**
- Absolute times: "8点", "晚上8点", "下午3点半"
- Relative times: "30分钟后", "2小时后", "明天"
- Time-of-day keywords: 早上(8), 中午(12), 下午(15), 晚上(20), 今晚(21)

**Usage:**
```python
from personal_agent.temporal_parser import TemporalParser

parser = TemporalParser(model_client=model_client)
result = parser.parse("晚上8点提醒我吃饭")
# result.iso_timestamp = "2024-01-15 20:00:00"
```

### 2. TodoManager (`src/personal_agent/todo_manager.py`)

High-level todo and reminder management.

**Key Methods:**
- `create_todo_from_text()`: Extract time and create todo from natural language
- `create_todo_with_time()`: Create todo with explicit time expression
- `get_pending_todos()`: List all pending todos
- `get_due_reminders()`: Get reminders due before a specific time
- `check_reminders()`: Check for due reminders and get next check time
- `mark_done()`: Mark todo as completed
- `format_reminder_message()`: Format friendly reminder message

**Usage:**
```python
from personal_agent.todo_manager import TodoManager

manager = TodoManager(database, logger, config)
result = manager.create_todo_from_text("晚上8点提醒我吃饭")
# Creates todo with reminder_at="2024-01-15 20:00:00"
```

### 3. Database Schema (`src/personal_agent/db.py`)

**todos table:**
```sql
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    reminder_at TEXT,              -- ISO 8601 timestamp
    status TEXT DEFAULT 'pending', -- pending/done/cancelled
    source TEXT DEFAULT 'user',    -- user/agent/system
    created_at TEXT,
    updated_at TEXT
)
```

**Methods:**
- `create_todo()`: Insert new todo
- `get_pending_todos()`: List pending todos
- `get_due_reminders()`: Get reminders due before time
- `mark_todo_done()`: Mark as completed
- `mark_todo_cancelled()`: Mark as cancelled

### 4. Scheduler Job (`src/personal_agent/jobs.py`)

**reminder_check_job**: Runs every minute to check and send due reminders.

```python
def reminder_check_job(config, database, message_service, logger):
    # 1. Check for due reminders
    # 2. Send proactive messages for each
    # 3. Record to timeline
```

### 5. Life Loop Integration (`src/personal_agent/life_loop.py`)

**_build_reminder_opportunity()**: Generates life-loop opportunities when reminders are due.

### 6. Service Integration (`src/personal_agent/service.py`)

**send_proactive_message()**: Sends proactive messages through the outbound channel.

## Configuration

No special configuration needed. Reminder job is auto-registered in scheduler.

## Usage Examples

### From User Message

```python
from personal_agent.todo_manager import extract_todo_from_message

result = extract_todo_from_message(
    "晚上8点提醒我吃饭",
    database,
    logger,
    config,
    model_client
)
# result.success = True
# result.parsed_time = "2024-01-15 20:00:00"
```

### Manual Todo Creation

```python
from personal_agent.todo_manager import TodoManager

manager = TodoManager(database, logger, config)

# With natural language
result = manager.create_todo_from_text("明天下午3点开会")

# With explicit time
result = manager.create_todo_with_time(
    content="开会",
    time_expression="明天下午3点"
)
```

### Checking Reminders

```python
# Get all pending
pending = manager.get_pending_todos()

# Get due reminders
due = manager.get_due_reminders()

# Check with auto-next-check-time
check_result = manager.check_reminders()
# check_result.due_reminders = [TodoItem, ...]
# check_result.next_check_time = "2024-01-15 21:00:00"
```

## Time Parsing Examples

| Input | Output | Confidence |
|-------|--------|------------|
| "8点" | Today 08:00 (or tomorrow if passed) | 0.90 |
| "晚上8点" | Today 20:00 | 0.90 |
| "明天下午3点" | Tomorrow 15:00 | 0.85 |
| "半小时后" | Now + 30 min | 0.95 |
| "今晚" | Today 21:00 | 0.85 |
| "早上" | Today 08:00 | 0.85 |

## Integration Points

1. **Scheduler**: `reminder_check_job` runs every minute
2. **Life Loop**: `_build_reminder_opportunity` generates opportunities
3. **Orchestrator**: Handles reminder opportunities (acknowledges, no action needed)
4. **Service**: `send_proactive_message` for outbound delivery

## Testing

```bash
# Test temporal parser
python -c "
from personal_agent.temporal_parser import TemporalParser
parser = TemporalParser()
print(parser.parse('晚上8点'))
"

# Test todo manager
python -c "
from personal_agent.todo_manager import TodoManager
# ... setup database, logger, config
manager = TodoManager(database, logger, config)
print(manager.create_todo_from_text('明天下午3点开会'))
"
```

## Future Enhancements

- Recurring reminders (每天, 每周)
- Timezone-aware parsing
- More natural language patterns
- Reminder snooze functionality
- Integration with calendar events

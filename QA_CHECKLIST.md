# CareLog QA Checklist

## How to Run QA Tests

Ask Claude to run QA by saying:
- "Run QA tests on CareLog"
- "Test the summary sync flow"
- "Check if the pages are working"

---

## Getting a Test User ID

**IMPORTANT**: All QA tests require a valid userId. Here's how to get one:

### Option 1: From Recent Testing (Fastest)
If you just tested CareLog manually, provide Claude the URL you used:
- Example: `https://carelog.vivebien.io/abc12345-1234-5678-9abc-def012345678`
- The userId is the UUID after the domain

### Option 2: Via n8n Workflow
Run this query using the "CareLog_Claude Database Access" n8n workflow:
```sql
SELECT u.id, u.name, u.language
FROM users u
JOIN memories m ON u.id = m.user_id
WHERE m.category = 'health_summary'
ORDER BY m.created_at DESC
LIMIT 3;
```

### Option 3: From WhatsApp Test
Send a message to the CareLog WhatsApp number, complete the intake flow, and use the userId from the summary link sent back.

---

## Test Scenarios

### 1. Landing Page (`/{userId}`)

**Setup**: Need a valid userId with summary data

**Tests**:
- [ ] Page loads without errors
- [ ] User name displays correctly
- [ ] Summary content displays (not raw labels)
- [ ] "Update" button navigates to /suggest/{userId}
- [ ] "View History" button navigates to /history/{userId}
- [ ] "Version for your Doctor" button navigates to /doctor/{userId}
- [ ] Language detection works (test with es, en users)

**Red Flags**:
- Summary shows "What worsens: What worsens:" (format corruption)
- Summary shows "Patient reports" (not cleaned)
- Summary shows raw labels like "Main concern:" or "MOTIVO PRINCIPAL"

---

### 2. Update Page (`/suggest/{userId}`)

**Tests**:
- [ ] Page loads with existing data populated
- [ ] Fields are parsed correctly from database
- [ ] Medication chips display existing medications
- [ ] Can add new medication with + button
- [ ] Can remove medication with × button
- [ ] "Update" button saves to database
- [ ] After save, redirects to landing page
- [ ] Landing page shows updated content

**Red Flags**:
- Fields are empty when data exists in DB
- Save fails silently
- Data not showing on landing page after save

---

### 3. Doctor Page (`/doctor/{userId}`)

**Tests**:
- [ ] Page loads without errors
- [ ] "Motivo de consulta" section populated
- [ ] HPI fields display if data exists
- [ ] Copy/Share/Print buttons work
- [ ] Multi-language support works

---

### 4. Data Sync Flow

**Full Flow Test**:
1. Check current summary in database
2. Visit landing page - verify display
3. Click Update - verify fields populated
4. Make a change (e.g., add medication)
5. Click Update button
6. Verify database updated
7. Visit landing page - verify new data shows
8. Visit doctor page - verify new data shows

---

### 5. API Endpoints

**GET /api/summary/{userId}**
- [ ] Returns summary content
- [ ] Returns user language
- [ ] Returns updatedAt timestamp

**PUT /api/summary/{userId}**
- [ ] Updates existing summary
- [ ] Creates new summary if none exists
- [ ] Returns success response

**GET /api/doctor/{userId}**
- [ ] Returns parsed doctor note structure
- [ ] Handles missing fields gracefully

---

## Test Data

### Test User
Use the database to find a test user or create one:

```sql
-- Find users with summaries
SELECT u.id, u.name, u.phone, m.content
FROM users u
JOIN memories m ON u.id = m.user_id
WHERE m.category = 'health_summary'
LIMIT 5;
```

### Clear Test Data
```sql
-- Reset a user's summary for testing
UPDATE memories
SET content = 'Main concern: Test headache
Started: 2 days ago
Location: Left temple
What helps: Rest, dark room
Medications: Ibuprofen'
WHERE user_id = '{userId}' AND category = 'health_summary';
```

---

## Automated Checks (Claude can run)

### 1. API Health Check
```bash
curl -s https://carelog.vivebien.io/api/summary/{userId} | jq .
```

### 2. Database Check
Query via n8n workflow to verify data integrity

### 3. Browser Check
Use Claude in Chrome to:
- Take screenshots of pages
- Verify content displays correctly
- Test button clicks

---

## QA Schedule

**After Every Deployment**:
1. Run API health check
2. Visit landing page for test user
3. Verify no format corruption in display

**Weekly**:
1. Full flow test (update → save → verify)
2. Multi-language test
3. Doctor page verification

---

## Known Issues to Watch For

1. **Format Corruption**: Multiple "What worsens:" labels
2. **Missing Data**: Fields not parsing from AI summaries
3. **Sync Lag**: Summary link sent before DB save completes
4. **Language Mix**: Headers in wrong language

---

## Claude QA Workflow

### What Claude Can Do Autonomously

With **Claude in Chrome**:
- ✅ Navigate to pages and take screenshots
- ✅ Read page content and verify display
- ✅ Click buttons and navigate between pages
- ✅ Fill in form fields and test submissions
- ✅ Verify API responses via browser network tab

With **n8n Workflows** (when available):
- ✅ Query database for test users
- ✅ Verify database state after updates
- ✅ Check data integrity

With **Code Analysis**:
- ✅ Verify parsing functions handle all formats
- ✅ Check for missing error handling
- ✅ Review sync logic

### What Claude Needs From You

1. **Test userId**: Provide a URL or userId from your recent testing
2. **Expected behavior**: Describe what should happen for edge cases
3. **Bug reports**: Share screenshots of issues you encounter

### QA Commands

| Command | What It Does |
|---------|--------------|
| "Run QA on CareLog" | Full test suite with browser screenshots |
| "Test userId: {id}" | Tests specific user across all pages |
| "Check sync for {id}" | Tests update→save→display flow |
| "Verify API for {id}" | Checks all API endpoints |

### Sample QA Session

```
User: "Run QA on CareLog, userId: abc-123-456"

Claude will:
1. Navigate to https://carelog.vivebien.io/abc-123-456
2. Take screenshot of landing page
3. Verify summary displays correctly
4. Click "Update" button
5. Verify fields populated on suggest page
6. Test adding/removing medication
7. Save changes
8. Verify landing page updated
9. Check doctor page display
10. Report findings with screenshots
```


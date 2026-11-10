# VIP Email Report

Run the seven-day report for your Gmail inbox from VS Code. The project reads the current `VIP Email List.xlsx` in the parent Daily Tasks folder and saves `VIP_Email_YYYYmmdd_DoW.txt` alongside it.

## Open the project in VS Code

1. In VS Code, select **File → Open Folder**.
2. Open `<path_to_project>`.
3. Select **Terminal → New Terminal**. The terminal starts in the project folder.

## One-time setup

1. Check that Node.js 20 or later and Python 3.11 or later are available in the terminal.

   ```powershell
   node --version
   python --version
   ```

   If `python` opens the Microsoft Store or reports that Python is missing, install Python from [Python for Windows](https://www.python.org/downloads/windows/) and enable its PATH option. Reopen VS Code afterward. If you use a specific installation, set `$env:VIP_REPORT_PYTHON` to the full path to its `python.exe` in the VS Code terminal.

2. Install the JavaScript dependencies. The Python code uses the standard library.

   ```powershell
   npm.cmd ci
   ```

3. In the project folder, create `settings.xml` with your Gmail address. The report reads it at startup, and Git ignores this file.

   ```xml
   <settings>
     <mailbox>your@example.com</mailbox>
   </settings>
   ```

4. In Google Cloud, create or select a project and enable the Gmail API. Under **Google Auth Platform**, configure the app branding, select **External** under **Audience**, and add your Gmail address as a test user. Under **Data Access**, add `https://www.googleapis.com/auth/gmail.readonly`. Under **Clients**, create a **Desktop app** client and download the JSON. [Google Gmail API setup](https://developers.google.com/workspace/gmail/api/quickstart/nodejs)

5. Save the downloaded JSON as `credentials.json` in the local folder shown by the second command. The saved sign-in token goes there too.

   ```powershell
   New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\VipEmailReport"
   explorer.exe "$env:LOCALAPPDATA\VipEmailReport"
   ```

## Run the report

In the VS Code terminal, run:

```powershell
npm.cmd run report
```

On the first run, Google opens a browser to ask for read-only Gmail access. Sign in with the address in settings.xml. The terminal prints the matching message count and saved path. Close the report in any program that locks it before rerunning on the same date. A successful rerun replaces that day's report.

Google test-user authorization expires after seven days. To sign in again or change the saved Google account, run `npm.cmd run report -- --reauthorize`. [Google Auth Platform audience settings](https://support.google.com/cloud/answer/15549945?hl=en)

## Test the sign-in flow

Run `npm.cmd test` to exercise the local OAuth callback, PKCE code exchange, token refresh, and declined consent using a simulated Google token endpoint. These tests do not open Gmail or need your credentials.

## Follow the code

- **`report.mjs`** signs in to Gmail, pages through the Inbox, fetches the original headers and full messages, and chooses the Eastern Time filename. It passes data to Python through standard input.
- **`oauth.mjs`** opens Google sign-in and uses the Google OAuth client for the desktop code exchange. [Google desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app)
- **`format_report.py`** reads the workbook, matches exact sender addresses and domains, and sorts by Gmail's received timestamp. It decodes message bodies, converts HTML-only mail to plain text, applies the report filters, and writes the final file.
- **`package.json`** defines the run command and Gmail dependencies. **`.gitignore`** excludes local dependencies and credentials from version control.

Each email starts with the sender's full `From:` address. The next line has the date, time, and subject. The formatter removes whitespace-only lines, lines containing a URL, and lines that start with a pipe followed only by whitespace. It inserts exactly one blank line between emails after filtering. The code implements these rules directly. If you later change the Markdown prompt, update the corresponding code here too.

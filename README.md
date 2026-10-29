# AIU Canvas MCP Server

Local MCP server for retrieving course content from `https://aiu.instructure.com`.

It supports two authentication modes:

- **Token mode**: uses a Canvas access token through the official Canvas REST API.
- **Chrome mode**: connects to a dedicated logged-in Chrome window and uses your existing Canvas web session.

Use this only for Canvas content that your university account is allowed to access.

## Setup

```powershell
cd "C:\Users\egypt\OneDrive\Documents\New project\canvas-mcp-server"
npm install
npm run build
```

Copy `.env.example` to `.env`, then choose one auth mode.

## Option 1: Canvas Token Mode

In Canvas, open **Account > Settings > New Access Token**, create a token, and put it in `.env`:

```env
CANVAS_BASE_URL=https://aiu.instructure.com
CANVAS_AUTH_MODE=token
CANVAS_ACCESS_TOKEN=your-token-here
```

Then run:

```powershell
npm run build
npm start
```

## Option 2: Chrome Mode

Use this if Canvas access tokens are unavailable or disabled.

Start the dedicated Chrome profile:

```powershell
npm run chrome
```

Log in to AIU Canvas in the Chrome window that opens. Keep that Chrome window open while using the MCP server.

Then set `.env` like this:

```env
CANVAS_BASE_URL=https://aiu.instructure.com
CANVAS_AUTH_MODE=chrome
CHROME_DEBUG_URL=http://127.0.0.1:9222
```

Run the server:

```powershell
npm start
```

Security note: while the debug Chrome window is open, local apps can control that browser through port `9222`. Close the window when you are done.

### Using Another Canvas Site

The same server can connect to another Canvas instance, such as AWS Academy. Change only the base URL:

```env
CANVAS_BASE_URL=https://awsacademy.instructure.com
CANVAS_AUTH_MODE=chrome
CHROME_DEBUG_URL=http://127.0.0.1:9222
```

Then start Chrome with:

```powershell
$env:CANVAS_BASE_URL="https://awsacademy.instructure.com"
npm run chrome
```

Log in normally in that dedicated Chrome window. The course URL
`https://awsacademy.instructure.com/courses/159468/modules` belongs to course ID `159468`.

## MCP Client Config

Use the built `dist/index.js` file as a stdio MCP server.

```json
{
  "mcpServers": {
    "aiu-canvas": {
      "command": "node",
      "args": [
        "C:\\Users\\egypt\\OneDrive\\Documents\\New project\\canvas-mcp-server\\dist\\index.js"
      ],
      "env": {
        "CANVAS_BASE_URL": "https://aiu.instructure.com",
        "CANVAS_AUTH_MODE": "token",
        "CANVAS_ACCESS_TOKEN": "your-token-here"
      }
    }
  }
}
```

For Chrome mode, use this env instead:

```json
{
  "CANVAS_BASE_URL": "https://aiu.instructure.com",
  "CANVAS_AUTH_MODE": "chrome",
  "CHROME_DEBUG_URL": "http://127.0.0.1:9222"
}
```

## Tools

- `canvas_auth_status`: verify the configured Canvas login works.
- `canvas_list_courses`: list available courses.
- `canvas_search_courses`: search courses by name, code, ID, or term.
- `canvas_get_course`: get course details and syllabus.
- `canvas_list_course_tabs`: list visible navigation tabs.
- `canvas_list_modules`: list course modules.
- `canvas_list_module_items`: list items inside one module.
- `canvas_get_module_item_content`: fetch a module item and follow its Canvas API URL.
- `canvas_list_pages`: list course pages.
- `canvas_get_page`: get a page body.
- `canvas_list_assignments`: list assignments.
- `canvas_get_assignment`: get assignment details.
- `canvas_list_discussions`: list discussions or announcements.
- `canvas_get_discussion`: get one discussion or announcement.
- `canvas_list_quizzes`: list classic Canvas quizzes.
- `canvas_get_quiz`: get classic quiz metadata.
- `canvas_list_files`: list course or folder files.
- `canvas_get_file`: get file metadata.
- `canvas_download_file`: download a file locally.
- `canvas_fetch_url_or_api_path`: fetch an `/api/v1/...` path or translate a normal Canvas course URL.

## Good First Prompts

Ask your MCP client things like:

```text
Use canvas_auth_status to check my Canvas connection.
```

```text
List my active Canvas courses, then show me the modules for the course named Data Integrity.
```

```text
Fetch the content behind this Canvas URL: https://aiu.instructure.com/courses/12345/modules/items/67890
```

## Notes

- File downloads are written to `CANVAS_DOWNLOAD_DIR`, or `./downloads` by default.
- HTML fields such as page bodies and assignment descriptions are returned with a plain-text companion field.
- Chrome mode can also return rendered page text for Canvas URLs that do not map cleanly to a Canvas API endpoint.
- Locked, unpublished, or unavailable content remains locked; the server does not bypass Canvas permissions.

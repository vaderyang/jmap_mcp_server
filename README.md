# JMAP MCP - Jmap Server Integration

A Model Context Protocol (MCP) server for interacting with Jmap Server via JMAP protocol, supporting email, calendar, and contacts.

## Demo

Here's the JMAP MCP server working with Claude Desktop:

![JMAP MCP Server - Email Retrieval](claude_desktop_screenshot1.jpg)

![JMAP MCP Server - Email Search](claude_desktop_screenshot2.jpg)

The screenshots show the MCP tools successfully retrieving and searching email data from a JMAP server, demonstrating seamless integration between Claude Desktop and your email system.

## Configuration

### Environment Variables (Recommended)

The server can be configured using environment variables passed through MCP client configuration:

- `JMAP_BASE_URL` - Base URL of your Jmap Mail server (e.g., `https://mail.example.com`)
- `JMAP_USERNAME` - Username/email for authentication
- `JMAP_PASSWORD` - Password for authentication
- `JMAP_ACCOUNT_ID` - (Optional) Specific account ID to use

These should be configured in your MCP client's configuration file (see examples below).

### Config File (Fallback)

If environment variables are not set, the server will look for configuration files in:

1. Path specified by `JMAP_CONFIG_PATH` environment variable
2. `jmap-config.json` in current working directory
3. `.jmap-config.json` in user's home directory

Example config file:
```json
{
  "baseUrl": "https://mail.example.com",
  "username": "user@example.com",
  "password": "your-password",
  "accountId": "account123"
}
```

## Features

- Auto-connects on startup if configuration is provided
- Supports comprehensive JMAP operations:

### Email Operations
- Get mailboxes
- Get emails
- Search emails
- Send emails
- Mark as read/unread
- Delete emails

### Calendar Operations
- Get calendars
- Get calendar events
- Create calendar events
- Update calendar events
- Delete calendar events

### Contact Operations
- Get address books
- Get contacts
- Search contacts
- Create contacts
- Update contacts
- Delete contacts

## Usage

The server will automatically attempt to connect using the configured credentials on startup. If successful, all email operations will be available immediately.

If no configuration is provided or connection fails, you can use the `connect_jmap` tool to establish a connection manually.

## Installation

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Access to a Jmap Mail server with JMAP enabled

### Setup

1. **Clone the repository:**
```bash
git clone https://github.com/vaderyang/jmap_mcp_server.git
cd jmap_mcp_server
```

2. **Install dependencies:**
```bash
npm install
```

3. **Build the project:**
```bash
npm run build
```

## Usage

### Running the MCP Server

The server communicates via stdio and is designed to be used with MCP-compatible clients:

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

### Configuration with Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "jmap-mail": {
      "command": "node",
      "args": ["/path/to/jmap-mcp-server/dist/index.js"],
      "env": {
        "JMAP_BASE_URL": "https://mail.example.com",
        "JMAP_USERNAME": "user@example.com",
        "JMAP_PASSWORD": "your-password",
        "JMAP_ACCOUNT_ID": "account123"
      }
    }
  }
}
```

### Alternative: Using Config File

If you prefer not to put credentials in the Claude Desktop config, you can omit the `env` section and use a config file instead:

```json
{
  "mcpServers": {
    "jmap-mail": {
      "command": "node",
      "args": ["/path/to/jmap-mcp-server/dist/index.js"],
      "env": {
        "JMAP_CONFIG_PATH": "/path/to/your/jmap-config.json"
      }
    }
  }
}
```

### Configuration with Cursor

For Cursor, add the MCP server configuration to your workspace or global settings:

```json
{
  "@mcp": {
    "jmap-mail": {
      "command": "node",
      "args": ["/path/to/jmap-mcp-server/dist/index.js"],
      "env": {
        "JMAP_BASE_URL": "https://mail.example.com",
        "JMAP_USERNAME": "user@example.com",
        "JMAP_PASSWORD": "your-password",
        "JMAP_ACCOUNT_ID": "account123"
      }
    }
  }
}
```

## MCP Configuration Reference

For detailed setup instructions, refer to the official documentation:

### Claude Desktop
- **Official Documentation**: [Claude Desktop MCP Guide](https://modelcontextprotocol.io/docs/tools/claude-desktop)
- **Configuration Location**: 
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
  - Linux: `~/.config/Claude/claude_desktop_config.json`

### Cursor
- **Official Documentation**: [Cursor MCP Setup](https://docs.cursor.com/context/@mcp)
- **Configuration**: Add MCP servers through Cursor's settings or configuration files

### General MCP Resources
- **MCP Official Website**: [modelcontextprotocol.io](https://modelcontextprotocol.io/)
- **MCP GitHub Repository**: [github.com/modelcontextprotocol](https://github.com/modelcontextprotocol)
- **Sample MCP Servers**: [github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)

### Available Tools

#### `connect_jmap`
Connect to your Jmap Mail server. This is not required for other tools calling.

**Parameters:**
- `baseUrl`: Base URL of your Jmap server (e.g., `https://mail.example.com`)
- `username`: Your email/username
- `password`: Your password

#### `get_mailboxes`
Retrieve all mailboxes from the server.

#### `get_emails`
Get emails from a specific mailbox or all emails.

**Parameters:**
- `mailboxId` (optional): Specific mailbox ID
- `limit` (optional): Maximum number of emails (default: 50)

#### `get_email_by_id`
Retrieve a specific email by its ID.

**Parameters:**
- `emailId`: The email ID

#### `search_emails`
Search emails by text query.

**Parameters:**
- `query`: Search query string
- `limit` (optional): Maximum results (default: 20)

#### `send_email`
Send a new email.

**Parameters:**
- `to`: Array of recipient email addresses
- `subject`: Email subject
- `textBody` (optional): Plain text body
- `htmlBody` (optional): HTML body
- `cc` (optional): CC recipients
- `bcc` (optional): BCC recipients
- `inReplyTo` (optional): Message ID for replies
- `references` (optional): Reference message IDs

#### `mark_as_read`
Mark emails as read.

**Parameters:**
- `emailIds`: Array of email IDs

#### `mark_as_unread`
Mark emails as unread.

**Parameters:**
- `emailIds`: Array of email IDs

#### `delete_emails`
Delete emails (moves to trash).

**Parameters:**
- `emailIds`: Array of email IDs

### Calendar Tools

#### `get_calendars`
Retrieve all calendars from the server.

#### `get_calendar_events`
Get calendar events from a specific calendar or all calendars.

**Parameters:**
- `calendarId` (optional): Specific calendar ID
- `limit` (optional): Maximum number of events (default: 50)

#### `create_calendar_event`
Create a new calendar event.

**Parameters:**
- `calendarId`: Calendar ID to create the event in
- `title`: Event title
- `description` (optional): Event description
- `start`: Event start time in ISO 8601 format (e.g., "2024-01-15T10:00:00Z")
- `end`: Event end time in ISO 8601 format (e.g., "2024-01-15T11:00:00Z")
- `location` (optional): Event location
- `participants` (optional): Array of participant email addresses
- `showWithoutTime` (optional): Whether this is an all-day event (default: false)

#### `update_calendar_event`
Update an existing calendar event.

**Parameters:**
- `eventId`: Event ID to update
- `title` (optional): New event title
- `description` (optional): New event description
- `start` (optional): New event start time in ISO 8601 format
- `end` (optional): New event end time in ISO 8601 format
- `location` (optional): New event location
- `participants` (optional): New array of participant email addresses

#### `delete_calendar_event`
Delete a calendar event.

**Parameters:**
- `eventId`: Event ID to delete

### Contact Tools

#### `get_address_books`
Retrieve all address books from the server.

#### `get_contacts`
Get contacts from a specific address book or all address books.

**Parameters:**
- `addressBookId` (optional): Specific address book ID
- `limit` (optional): Maximum number of contacts (default: 50)

#### `search_contacts`
Search contacts by text query.

**Parameters:**
- `query`: Search query to find contacts
- `limit` (optional): Maximum number of results (default: 20)

#### `create_contact`
Create a new contact.

**Parameters:**
- `addressBookId`: Address book ID to create the contact in
- `firstName` (optional): Contact first name
- `lastName` (optional): Contact last name
- `emails` (optional): Array of email objects with `type` and `value`
- `phones` (optional): Array of phone objects with `type` and `value`
- `addresses` (optional): Array of address objects with `type`, `street`, `city`, `state`, `country`, `postalCode`
- `company` (optional): Contact company/organization
- `jobTitle` (optional): Contact job title
- `notes` (optional): Contact notes

#### `update_contact`
Update an existing contact.

**Parameters:**
- `contactId`: Contact ID to update
- `firstName` (optional): New contact first name
- `lastName` (optional): New contact last name
- `emails` (optional): New array of email objects with `type` and `value`
- `phones` (optional): New array of phone objects with `type` and `value`
- `addresses` (optional): New array of address objects with `type`, `street`, `city`, `state`, `country`, `postalCode`
- `company` (optional): New contact company/organization
- `jobTitle` (optional): New contact job title
- `notes` (optional): New contact notes

#### `delete_contact`
Delete a contact.

**Parameters:**
- `contactId`: Contact ID to delete

## Example Usage

Once connected to Claude with this MCP server, you can use natural language commands like:

**Emails:**
- "Show me my recent emails"
- "Search for emails about 'project update'"
- "Send an email to alice@example.com about the meeting"
- "Mark all unread emails as read"

**Calendar:**
- "Show me my calendars"
- "Get my calendar events for this week"
- "Create a meeting for tomorrow at 2 PM"
- "Update the project review meeting location"

**Contacts:**
- "Show me all my contacts"
- "Search for contacts named John"
- "Create a new contact for Jane Smith"
- "Update Alice's phone number"

## JMAP Protocol

This server implements the JMAP protocol for modern email, calendar, and contact operations:

- **JMAP Core** (`urn:ietf:params:jmap:core`)
- **JMAP Mail** (`urn:ietf:params:jmap:mail`)
- **JMAP Calendars** (`urn:ietf:params:jmap:calendars`)
- **JMAP Contacts** (`urn:ietf:params:jmap:contacts`)

## Jmap Configuration

Ensure your Jmap Mail server has JMAP enabled in the configuration:

```toml
[server.listener.jmap]
bind = ["0.0.0.0:8080"]
protocol = "jmap"
tls.implicit = false

[jmap]
default-language = "en"
```

## Security Considerations

- **Credentials**: The server requires username/password authentication
- **TLS**: Always use HTTPS endpoints for production
- **Network**: Ensure proper firewall rules for JMAP port access
- **Authentication**: Consider using application-specific passwords if available

## Development

### Project Structure

```
jmap-mcp-server/
├── src/
│   └── index.ts          # Main server implementation
├── dist/                 # Compile

#!/usr/bin/env node

/**
 * Comprehensive Test Suite for Jmap JMAP MCP Server
 * 
 * This script tests all features of the MCP server by sending JSON-RPC requests
 * directly to the server and verifying responses.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

// Load .env file if it exists
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value && !key.startsWith('#')) {
      process.env[key] = value;
    }
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = resolve(__dirname, '../dist/index.js');

class MCPTester {
  constructor() {
    this.requestId = 1;
    this.serverProcess = null;
    this.isConnected = false;
  }

  async startServer() {
    console.log('🚀 Starting MCP Server...');
    
    this.serverProcess = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Add your test credentials here or use environment variables
        JMAP_BASE_URL: process.env.JMAP_BASE_URL || 'https://your-jmap-server.com',
        JMAP_USERNAME: process.env.JMAP_USERNAME || 'your-username@domain.com',
        JMAP_PASSWORD: process.env.JMAP_PASSWORD || 'your-password'
      }
    });

    // Handle server stderr for debugging
    this.serverProcess.stderr.on('data', (data) => {
      console.log('📝 Server log:', data.toString().trim());
    });

    // Handle server errors
    this.serverProcess.on('error', (error) => {
      console.error('❌ Server error:', error);
    });

    // Wait a moment for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('✅ Server started');
  }

  async sendRequest(method, params = {}) {
    const request = {
      jsonrpc: '2.0',
      id: this.requestId++,
      method,
      params
    };

    console.log(`\n📤 Sending request: ${method}`);
    console.log('   Request:', JSON.stringify(request, null, 2));

    return new Promise((resolve, reject) => {
      let responseData = '';
      
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 30000); // 30 second timeout

      const onData = (data) => {
        responseData += data.toString();
        
        // Try to parse complete JSON response
        try {
          const lines = responseData.split('\n').filter(line => line.trim());
          for (const line of lines) {
            const response = JSON.parse(line);
            if (response.id === request.id) {
              clearTimeout(timeout);
              this.serverProcess.stdout.removeListener('data', onData);
              
              console.log('📥 Response received:');
              console.log('   Response:', JSON.stringify(response, null, 2));
              
              if (response.error) {
                reject(new Error(`Server error: ${response.error.message}`));
              } else {
                resolve(response.result);
              }
              return;
            }
          }
        } catch (e) {
          // Not a complete JSON yet, continue waiting
        }
      };

      this.serverProcess.stdout.on('data', onData);
      
      // Send the request
      this.serverProcess.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async testListTools() {
    console.log('\n=== Test 1: List Available Tools ===');
    try {
      const result = await this.sendRequest('tools/list');
      console.log('✅ Available tools:', result.tools.map(t => t.name).join(', '));
      return result.tools;
    } catch (error) {
      console.error('❌ Failed to list tools:', error.message);
      throw error;
    }
  }

  async testConnection(credentials) {
    console.log('\n=== Test 2: Server Connection ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'connect_jmap',
        arguments: credentials
      });
      console.log('✅ Connection successful');
      this.isConnected = true;
      return result;
    } catch (error) {
      console.error('❌ Connection failed:', error.message);
      console.log('💡 Make sure to set your JMAP_* environment variables');
      throw error;
    }
  }

  async testGetMailboxes() {
    console.log('\n=== Test 3: Get Mailboxes ===');
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'get_mailboxes',
        arguments: {}
      });
      const mailboxes = JSON.parse(result.content[0].text);
      console.log('✅ Found mailboxes:', mailboxes.list?.map(m => `${m.name} (${m.role || 'no role'})`) || 'No mailboxes found');
      return mailboxes;
    } catch (error) {
      console.error('❌ Failed to get mailboxes:', error.message);
      throw error;
    }
  }

  async testGetEmails(mailboxId = null, limit = 5) {
    console.log(`\n=== Test 4: Get Emails ${mailboxId ? `from ${mailboxId}` : '(all mailboxes)'} ===`);
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'get_emails',
        arguments: { mailboxId, limit }
      });
      const emailData = JSON.parse(result.content[0].text);
      const emails = emailData.emails?.list || [];
      console.log(`✅ Retrieved ${emails.length} emails`);
      if (emails.length > 0) {
        console.log('   Latest email:', {
          id: emails[0].id,
          subject: emails[0].subject,
          from: emails[0].from?.[0]?.email,
          receivedAt: emails[0].receivedAt
        });
      }
      return emailData;
    } catch (error) {
      console.error('❌ Failed to get emails:', error.message);
      throw error;
    }
  }

  async testGetEmailById(emailId) {
    console.log(`\n=== Test 5: Get Email by ID (${emailId}) ===`);
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'get_email_by_id',
        arguments: { emailId }
      });
      const emailData = JSON.parse(result.content[0].text);
      const email = emailData.list?.[0];
      if (email) {
        console.log('✅ Email details retrieved:', {
          subject: email.subject,
          from: email.from?.[0]?.email,
          hasAttachment: email.hasAttachment,
          preview: email.preview?.substring(0, 100) + '...'
        });
      }
      return emailData;
    } catch (error) {
      console.error('❌ Failed to get email by ID:', error.message);
      throw error;
    }
  }

  async testSearchEmails(query = 'test', limit = 3) {
    console.log(`\n=== Test 6: Search Emails ("${query}") ===`);
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'search_emails',
        arguments: { query, limit }
      });
      const searchData = JSON.parse(result.content[0].text);
      const emails = searchData.emails?.list || [];
      console.log(`✅ Found ${emails.length} emails matching "${query}"`);
      emails.forEach((email, index) => {
        console.log(`   ${index + 1}. ${email.subject} from ${email.from?.[0]?.email}`);
      });
      return searchData;
    } catch (error) {
      console.error('❌ Search failed:', error.message);
      throw error;
    }
  }

  async testSendEmail(testRecipient) {
    console.log(`\n=== Test 7: Send Email to ${testRecipient} ===`);
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'send_email',
        arguments: {
          to: [testRecipient],
          subject: `MCP Test Email - ${new Date().toISOString()}`,
          textBody: 'This is a test email sent from the JMAP MCP server.\n\nIf you receive this, the email sending feature is working correctly!',
          htmlBody: '<h1>MCP Test Email</h1><p>This is a test email sent from the JMAP MCP server.</p><p><strong>If you receive this, the email sending feature is working correctly!</strong></p>'
        }
      });
      console.log('✅ Email sent successfully!');
      console.log('   Result:', result.content[0].text);
      return result;
    } catch (error) {
      console.error('❌ Failed to send email:', error.message);
      throw error;
    }
  }

  async testMarkAsRead(emailIds) {
    console.log(`\n=== Test 8: Mark Emails as Read ===`);
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'mark_as_read',
        arguments: { emailIds }
      });
      console.log('✅ Emails marked as read');
      return result;
    } catch (error) {
      console.error('❌ Failed to mark emails as read:', error.message);
      throw error;
    }
  }

  async testMarkAsUnread(emailIds) {
    console.log(`\n=== Test 9: Mark Emails as Unread ===`);
    try {
      const result = await this.sendRequest('tools/call', {
        name: 'mark_as_unread',
        arguments: { emailIds }
      });
      console.log('✅ Emails marked as unread');
      return result;
    } catch (error) {
      console.error('❌ Failed to mark emails as unread:', error.message);
      throw error;
    }
  }

  async runAllTests() {
    console.log('🧪 Starting Comprehensive JMAP MCP Server Tests');
    console.log('=' * 60);

    try {
      // Start the server
      await this.startServer();

      // Test 1: List tools
      const tools = await this.testListTools();

      // Check if we have credentials for connection test
      const credentials = {
        baseUrl: process.env.JMAP_BASE_URL,
        username: process.env.JMAP_USERNAME,
        password: process.env.JMAP_PASSWORD
      };

      if (!credentials.baseUrl || !credentials.username || !credentials.password) {
        console.log('\n⚠️  Skipping server-dependent tests - no credentials provided');
        console.log('   Set JMAP_BASE_URL, JMAP_USERNAME, and JMAP_PASSWORD to run full tests');
        return;
      }

      // Test 2: Connection
      await this.testConnection(credentials);

      // Test 3: Get mailboxes
      const mailboxes = await this.testGetMailboxes();

      // Test 4: Get emails
      const emailData = await this.testGetEmails();
      const emails = emailData.emails?.list || [];

      // Test 5: Get email by ID (if we have emails)
      if (emails.length > 0) {
        await this.testGetEmailById(emails[0].id);

        // Test 8 & 9: Mark as read/unread (using first email)
        await this.testMarkAsRead([emails[0].id]);
        await this.testMarkAsUnread([emails[0].id]);
      }

      // Test 6: Search emails
      await this.testSearchEmails('test');

      // Test 7: Send email (requires a test recipient)
      const testRecipient = process.env.TEST_EMAIL_RECIPIENT || credentials.username;
      console.log(`\n📧 Testing email sending to: ${testRecipient}`);
      await this.testSendEmail(testRecipient);

      console.log('\n🎉 All tests completed successfully!');
      
    } catch (error) {
      console.error('\n💥 Test suite failed:', error.message);
      throw error;
    } finally {
      if (this.serverProcess) {
        console.log('\n🛑 Stopping server...');
        this.serverProcess.kill();
      }
    }
  }

  stopServer() {
    if (this.serverProcess) {
      this.serverProcess.kill();
    }
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new MCPTester();
  
  // Handle process termination
  process.on('SIGINT', () => {
    console.log('\n👋 Received SIGINT, stopping tests...');
    tester.stopServer();
    process.exit(0);
  });

  tester.runAllTests()
    .then(() => {
      console.log('\n✅ Test suite completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Test suite failed:', error.message);
      process.exit(1);
    });
}

export default MCPTester;


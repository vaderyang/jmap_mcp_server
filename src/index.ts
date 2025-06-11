#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

interface JMAPSession {
  accountId: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

interface JmapConfig {
  baseUrl: string;
  username: string;
  password: string;
  accountId?: string;
}

// Helper function to create default config from environment variables
function createDefaultConfig(): JmapConfig | null {
  const baseUrl = process.env.JMAP_BASE_URL;
  const username = process.env.JMAP_USERNAME;
  const password = process.env.JMAP_PASSWORD;
  const accountId = process.env.JMAP_ACCOUNT_ID; // Optional account ID

  if (!baseUrl || !username || !password) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''), // Remove trailing slash if present
    username,
    password,
    accountId,
  };
}

class JmapJMAPClient {
  private config: JmapConfig;
  private session: JMAPSession | null = null;
  private authToken: string | null = null;

  constructor(config: JmapConfig) {
    this.config = config;
  }

  private async authenticate(): Promise<void> {
    console.error(`Attempting authentication to ${this.config.baseUrl}`);
    
    // Try basic auth first (most common for Jmap)
    const credentials = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
    
    // First, try to get JMAP session to test if server is reachable
    try {
      const sessionUrl = `${this.config.baseUrl}/.well-known/jmap`;
      console.error(`Testing JMAP discovery at: ${sessionUrl}`);
      
      const sessionResponse = await fetch(sessionUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
      });

      console.error(`JMAP discovery response status: ${sessionResponse.status}`);
      
      if (!sessionResponse.ok) {
        const errorText = await sessionResponse.text();
        console.error(`JMAP discovery failed: ${sessionResponse.status} ${sessionResponse.statusText}`);
        console.error(`Response body: ${errorText}`);
        
        // Try alternative endpoints
        const alternativeUrls = [
          `${this.config.baseUrl}/jmap`,
          `${this.config.baseUrl}/jmap/session`,
          `${this.config.baseUrl}/.well-known/jmap-session`,
        ];
        
        for (const altUrl of alternativeUrls) {
          console.error(`Trying alternative endpoint: ${altUrl}`);
          const altResponse = await fetch(altUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${credentials}`,
              'Content-Type': 'application/json',
            },
          });
          
          if (altResponse.ok) {
            console.error(`Success with alternative endpoint: ${altUrl}`);
            break;
          } else {
            console.error(`Alternative endpoint failed: ${altResponse.status}`);
          }
        }
        
        throw new Error(`JMAP discovery failed: ${sessionResponse.status} ${sessionResponse.statusText}. Response: ${errorText}`);
      }

      this.authToken = credentials; // Use basic auth token
      console.error('Authentication successful');
      
    } catch (error) {
      console.error(`Authentication error details:`, error);
      throw new Error(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getSession(): Promise<JMAPSession> {
    if (!this.authToken) {
      await this.authenticate();
    }

    const sessionUrl = `${this.config.baseUrl}/.well-known/jmap`;
    console.error(`Getting JMAP session from: ${sessionUrl}`);
    
    const response = await fetch(sessionUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${this.authToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Session request failed: ${response.status} ${response.statusText}`);
      console.error(`Response body: ${errorText}`);
      throw new Error(`Session request failed: ${response.status} ${response.statusText}. Response: ${errorText}`);
    }

    const sessionData = await response.json() as any;
    console.error('Session data received:', JSON.stringify(sessionData, null, 2));
    
    this.session = {
      accountId: this.config.accountId || sessionData.primaryAccounts?.['urn:ietf:params:jmap:mail'] || Object.keys(sessionData.accounts || {})[0],
      apiUrl: sessionData.apiUrl,
      downloadUrl: sessionData.downloadUrl,
      uploadUrl: sessionData.uploadUrl,
      eventSourceUrl: sessionData.eventSourceUrl,
      state: sessionData.state,
    };

    console.error(`Using account ID: ${this.session.accountId}`);
    console.error(`API URL: ${this.session.apiUrl}`);
    
    return this.session;
  }

  private mailboxCache: any[] = [];

  private async jmapRequest(methodCalls: any[]): Promise<any> {
    if (!this.session) {
      await this.getSession();
    }

    console.error(`Making JMAP request to: ${this.session!.apiUrl}`);
    console.error(`Method calls:`, JSON.stringify(methodCalls, null, 2));

    const response = await fetch(this.session!.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        using: [
          'urn:ietf:params:jmap:core',
          'urn:ietf:params:jmap:mail',
          'urn:ietf:params:jmap:calendars',
          'urn:ietf:params:jmap:contacts',
        ],
        methodCalls,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`JMAP request failed: ${response.status} ${response.statusText}`);
      console.error(`Response body: ${errorText}`);
      throw new Error(`JMAP request failed: ${response.status} ${response.statusText}. Response: ${errorText}`);
    }

    const data = await response.json() as any;
    console.error('JMAP response:', JSON.stringify(data, null, 2));
    return data;
  }

  private async findMailboxByName(mailboxName: string): Promise<string | null> {
    if (this.mailboxCache.length === 0) {
      const mailboxes = await this.getMailboxes();
      this.mailboxCache = mailboxes.list || [];
    }

    const normalizedName = mailboxName.toLowerCase().trim();
    
    // Try exact match first
    let mailbox = this.mailboxCache.find(mb => 
      mb.name.toLowerCase() === normalizedName
    );
    
    // Try partial match
    if (!mailbox) {
      mailbox = this.mailboxCache.find(mb => 
        mb.name.toLowerCase().includes(normalizedName)
      );
    }
    
    // Try role-based matching for common mailbox types
    if (!mailbox) {
      const roleMap: { [key: string]: string } = {
        'inbox': 'inbox',
        'sent': 'sent',
        'draft': 'drafts',
        'drafts': 'drafts',
        'trash': 'trash',
        'deleted': 'trash',
        'spam': 'junk',
        'junk': 'junk',
        'archive': 'archive',
        'outbox': 'outbox'
      };
      
      const role = roleMap[normalizedName];
      if (role) {
        mailbox = this.mailboxCache.find(mb => mb.role === role);
      }
    }
    
    return mailbox ? mailbox.id : null;
  }

  async getMailboxes(): Promise<any> {
    const response = await this.jmapRequest([
      ['Mailbox/get', {
        accountId: this.session?.accountId,
        ids: null,
      }, 'mailboxes'],
    ]);

    const result = response.methodResponses[0][1];
    
    // Update mailbox cache for name resolution
    this.mailboxCache = result.list || [];
    
    return result;
  }

  async getEmails(mailboxId?: string, limit: number = 50): Promise<any> {
    // If no mailboxId specified, get from all mailboxes
    if (!mailboxId) {
      const response = await this.jmapRequest([
        ['Email/query', {
          accountId: this.session?.accountId,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit,
        }, 'query'],
        ['Email/get', {
          accountId: this.session?.accountId,
          '#ids': {
            resultOf: 'query',
            name: 'Email/query',
            path: '/ids',
          },
          properties: [
            'id', 'subject', 'from', 'to', 'cc', 'bcc', 
            'receivedAt', 'sentAt', 'hasAttachment', 'preview',
            'keywords', 'size', 'mailboxIds'
          ],
        }, 'emails'],
      ]);

      return {
        query: response.methodResponses[0][1],
        emails: response.methodResponses[1][1],
        mailboxUsed: 'all',
      };
    }

    // If mailboxId looks like a name rather than ID, try to resolve it
    let resolvedMailboxId: string | undefined = mailboxId;
    if (mailboxId && !mailboxId.match(/^[a-z]$/)) {  // Changed from startsWith('M') to single letter check
      const foundMailboxId = await this.findMailboxByName(mailboxId);
      if (!foundMailboxId) {
        throw new Error(`Mailbox "${mailboxId}" not found. Available mailboxes: ${this.mailboxCache.map(mb => mb.name).join(', ')}`);
      }
      resolvedMailboxId = foundMailboxId;
    }
    
    const filter = resolvedMailboxId ? { inMailbox: resolvedMailboxId } : {};
    
    const response = await this.jmapRequest([
      ['Email/query', {
        accountId: this.session?.accountId,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit,
      }, 'query'],
      ['Email/get', {
        accountId: this.session?.accountId,
        '#ids': {
          resultOf: 'query',
          name: 'Email/query',
          path: '/ids',
        },
        properties: [
          'id', 'subject', 'from', 'to', 'cc', 'bcc', 
          'receivedAt', 'sentAt', 'hasAttachment', 'preview',
          'keywords', 'size', 'mailboxIds'
        ],
      }, 'emails'],
    ]);

    return {
      query: response.methodResponses[0][1],
      emails: response.methodResponses[1][1],
      mailboxUsed: resolvedMailboxId,
    };
  }

  async getEmailById(emailId: string): Promise<any> {
    const response = await this.jmapRequest([
      ['Email/get', {
        accountId: this.session?.accountId,
        ids: [emailId],
        properties: [
          'id', 'subject', 'from', 'to', 'cc', 'bcc',
          'receivedAt', 'sentAt', 'hasAttachment', 'preview',
          'bodyStructure', 'bodyValues', 'textBody', 'htmlBody',
          'keywords', 'size', 'references', 'inReplyTo'
        ],
        bodyProperties: ['partId', 'type', 'size'],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: 1024 * 1024, // 1MB
      }, 'email'],
    ]);

    return response.methodResponses[0][1];
  }

  async searchEmails(query: string, limit: number = 20, mailboxId?: string): Promise<any> {
    // If mailboxId looks like a name rather than ID, try to resolve it
    let resolvedMailboxId: string | undefined = mailboxId;
    if (mailboxId && !mailboxId.startsWith('M')) {
      const foundMailboxId = await this.findMailboxByName(mailboxId);
      if (!foundMailboxId) {
        throw new Error(`Mailbox "${mailboxId}" not found. Available mailboxes: ${this.mailboxCache.map(mb => mb.name).join(', ')}`);
      }
      resolvedMailboxId = foundMailboxId;
    }

    const filter: any = {
      text: query,
    };
    
    if (resolvedMailboxId) {
      filter.inMailbox = resolvedMailboxId;
    }

    const response = await this.jmapRequest([
      ['Email/query', {
        accountId: this.session?.accountId,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit,
      }, 'search'],
      ['Email/get', {
        accountId: this.session?.accountId,
        '#ids': {
          resultOf: 'search',
          name: 'Email/query',
          path: '/ids',
        },
        properties: [
          'id', 'subject', 'from', 'to', 'receivedAt', 
          'preview', 'hasAttachment', 'keywords', 'mailboxIds'
        ],
      }, 'emails'],
    ]);

    return {
      query: response.methodResponses[0][1],
      emails: response.methodResponses[1][1],
      mailboxUsed: resolvedMailboxId,
    };
  }

  async sendEmail(emailData: {
    to: string[];
    subject: string;
    textBody?: string;
    htmlBody?: string;
    cc?: string[];
    bcc?: string[];
    inReplyTo?: string;
    references?: string[];
  }): Promise<any> {
    console.error('=== Starting sendEmail process ===');
    console.error('Email data:', JSON.stringify(emailData, null, 2));

    // Validate required fields
    if (!emailData.to || emailData.to.length === 0) {
      throw new Error('Recipients (to field) are required');
    }
    if (!emailData.subject) {
      throw new Error('Subject is required');
    }
    if (!emailData.textBody && !emailData.htmlBody) {
      throw new Error('Either textBody or htmlBody is required');
    }

    // Ensure mailboxes are loaded
    if (this.mailboxCache.length === 0) {
      console.error('Loading mailboxes...');
      await this.getMailboxes();
    }

    // Find the Drafts mailbox - try multiple strategies
    let draftsMailboxId: string | null = null;
    
    // Strategy 1: Look for role-based drafts
    for (const mailbox of this.mailboxCache) {
      if (mailbox.role === 'drafts') {
        draftsMailboxId = mailbox.id;
        console.error(`Found drafts mailbox by role: ${mailbox.name} (${mailbox.id})`);
        break;
      }
    }
    
    // Strategy 2: Look for name-based drafts
    if (!draftsMailboxId) {
      for (const mailbox of this.mailboxCache) {
        if (mailbox.name && mailbox.name.toLowerCase().includes('draft')) {
          draftsMailboxId = mailbox.id;
          console.error(`Found drafts mailbox by name: ${mailbox.name} (${mailbox.id})`);
          break;
        }
      }
    }

    // Strategy 3: Use first writable mailbox
    if (!draftsMailboxId && this.mailboxCache.length > 0) {
      // Look for inbox or any writable mailbox
      const writableMailbox = this.mailboxCache.find(mb => 
        mb.role === 'inbox' || 
        (!mb.isReadOnly && mb.myRights && (mb.myRights.mayAddItems || mb.myRights.mayCreateChild))
      );
      if (writableMailbox) {
        draftsMailboxId = writableMailbox.id;
        console.error(`Using writable mailbox: ${writableMailbox.name} (${writableMailbox.id})`);
      } else {
        // Last resort: use first mailbox
        draftsMailboxId = this.mailboxCache[0].id;
        console.error(`Using first available mailbox: ${this.mailboxCache[0].name} (${this.mailboxCache[0].id})`);
      }
    }

    if (!draftsMailboxId) {
      throw new Error('No suitable mailbox found for creating draft email');
    }

    // Prepare sender information - use authenticated username as full email
    // If username doesn't contain @, assume it needs domain from baseUrl
    let fromEmail = this.config.username;
    if (!fromEmail.includes('@')) {
      // Extract domain from baseUrl
      const url = new URL(this.config.baseUrl);
      const domain = url.hostname.replace(/^mail\./, ''); // Remove 'mail.' prefix if present
      fromEmail = `${this.config.username}@${domain}`;
    }
    console.error(`Using sender email: ${fromEmail}`);

    // Build the email object with proper JMAP structure
    const email: any = {
      from: [{ email: fromEmail }],
      to: emailData.to.map(email => ({ email: email.trim() })),
      subject: emailData.subject,
      keywords: { '$draft': true },
      mailboxIds: { [draftsMailboxId]: true }
    };

    // Add optional recipients
    if (emailData.cc && emailData.cc.length > 0) {
      email.cc = emailData.cc.map(email => ({ email: email.trim() }));
    }

    if (emailData.bcc && emailData.bcc.length > 0) {
      email.bcc = emailData.bcc.map(email => ({ email: email.trim() }));
    }

    // Add reply references
    if (emailData.inReplyTo) {
      email.inReplyTo = emailData.inReplyTo;
    }
    if (emailData.references && emailData.references.length > 0) {
      email.references = emailData.references;
    }

    // Handle body content with improved structure
    // Note: Jmap doesn't allow charset in bodyStructure when partId is specified
    if (emailData.htmlBody && emailData.textBody) {
      // Multipart: both HTML and text
      email.bodyStructure = {
        type: 'multipart/alternative',
        subParts: [
          {
            partId: '1',
            type: 'text/plain'
          },
          {
            partId: '2', 
            type: 'text/html'
          }
        ]
      };
      email.bodyValues = {
        '1': { 
          value: emailData.textBody
        },
        '2': { 
          value: emailData.htmlBody
        }
      };
    } else if (emailData.htmlBody) {
      // HTML only
      email.bodyStructure = {
        type: 'text/html',
        partId: '1'
      };
      email.bodyValues = {
        '1': { 
          value: emailData.htmlBody
        }
      };
    } else {
      // Text only (default)
      email.bodyStructure = {
        type: 'text/plain',
        partId: '1'
      };
      email.bodyValues = {
        '1': { 
          value: emailData.textBody || ''
        }
      };
    }

    console.error('Creating email with structure:', JSON.stringify(email, null, 2));

    try {
      // Step 1: Create the draft
      console.error('=== Step 1: Creating draft ===');
      const createResponse = await this.jmapRequest([
        ['Email/set', {
          accountId: this.session?.accountId,
          create: {
            'draft': email
          }
        }, 'createDraft']
      ]);

      console.error('Create draft response:', JSON.stringify(createResponse, null, 2));

      const createResult = createResponse.methodResponses[0][1];
      
      // Check for creation errors
      if (createResult.notCreated && createResult.notCreated.draft) {
        const error = createResult.notCreated.draft;
        console.error('Draft creation failed:', error);
        throw new Error(`Failed to create draft: ${error.type || 'Unknown error'} - ${error.description || JSON.stringify(error)}`);
      }

      if (!createResult.created || !createResult.created.draft) {
        console.error('No draft created in response:', createResult);
        throw new Error('Draft creation failed - no created object returned');
      }

      const draftId = createResult.created.draft.id;
      console.error(`✅ Created draft with ID: ${draftId}`);

      // Step 2: Submit for sending
      console.error('=== Step 2: Submitting email for sending ===');
      
      // Build submission envelope with correct sender
      const envelope = {
        mailFrom: { email: fromEmail },
        rcptTo: [
          ...emailData.to.map(email => ({ email: email.trim() })),
          ...(emailData.cc || []).map(email => ({ email: email.trim() })),
          ...(emailData.bcc || []).map(email => ({ email: email.trim() }))
        ]
      };
      
      // Validate that all email addresses contain @ symbol
      const allEmails = [fromEmail, ...emailData.to, ...(emailData.cc || []), ...(emailData.bcc || [])];
      for (const email of allEmails) {
        if (!email.includes('@')) {
          throw new Error(`Invalid email address: "${email}". Email addresses must be in the format user@domain.com`);
        }
      }
      
      console.error('Submission envelope:', JSON.stringify(envelope, null, 2));
      
      const submitResponse = await this.jmapRequest([
        ['EmailSubmission/set', {
          accountId: this.session?.accountId,
          create: {
            'send': {
              emailId: draftId,
              identityId: this.session?.accountId, // Use accountId as identityId
              envelope
            }
          }
        }, 'submitEmail']
      ]);

      console.error('Submit email response:', JSON.stringify(submitResponse, null, 2));

      const submitResult = submitResponse.methodResponses[0][1];
      
      // Check for submission errors
      if (submitResult.notCreated && submitResult.notCreated.send) {
        const error = submitResult.notCreated.send;
        console.error('Email submission failed:', error);
        throw new Error(`Failed to send email: ${error.type || 'Unknown error'} - ${error.description || JSON.stringify(error)}`);
      }

      if (!submitResult.created || !submitResult.created.send) {
        console.error('No submission created in response:', submitResult);
        throw new Error('Email submission failed - no submission object returned');
      }

      console.error('✅ Email sent successfully!');
      
      return {
        success: true,
        emailId: draftId,
        submissionId: submitResult.created.send.id,
        createResponse: createResult,
        submitResponse: submitResult,
        message: `Email sent successfully to ${emailData.to.join(', ')}`
      };
      
    } catch (error) {
      console.error('❌ Error in sendEmail process:', error);
      
      // Provide more helpful error messages
      if (error instanceof Error) {
        if (error.message.includes('not found') || error.message.includes('404')) {
          throw new Error('Email service endpoint not found. Please check your JMAP server configuration.');
        }
        if (error.message.includes('unauthorized') || error.message.includes('401')) {
          throw new Error('Authentication failed. Please check your credentials.');
        }
        if (error.message.includes('forbidden') || error.message.includes('403')) {
          throw new Error('Insufficient permissions to send email. Please check your account permissions.');
        }
      }
      
      throw error;
    }
  }

  async markAsRead(emailIds: string[]): Promise<any> {
    const response = await this.jmapRequest([
      ['Email/set', {
        accountId: this.session?.accountId,
        update: Object.fromEntries(
          emailIds.map(id => [id, { 'keywords/$seen': true }])
        )
      }, 'markRead']
    ]);

    return response.methodResponses[0][1];
  }

  async markAsUnread(emailIds: string[]): Promise<any> {
    const response = await this.jmapRequest([
      ['Email/set', {
        accountId: this.session?.accountId,
        update: Object.fromEntries(
          emailIds.map(id => [id, { 'keywords/$seen': null }])
        )
      }, 'markUnread']
    ]);

    return response.methodResponses[0][1];
  }

  async deleteEmails(emailIds: string[]): Promise<any> {
    const response = await this.jmapRequest([
      ['Email/set', {
        accountId: this.session?.accountId,
        update: Object.fromEntries(
          emailIds.map(id => [id, { 'keywords/$deleted': true }])
        )
      }, 'delete']
    ]);

    return response.methodResponses[0][1];
  }

  // Calendar methods
  async getCalendars(): Promise<any> {
    const response = await this.jmapRequest([
      ['Calendar/get', {
        accountId: this.session!.accountId,
      }, 'a']
    ]);

    return response.methodResponses[0][1];
  }

  async getCalendarEvents(calendarId?: string, limit: number = 50): Promise<any> {
    const filter: any = {};
    if (calendarId) {
      filter.inCalendar = calendarId;
    }

    const response = await this.jmapRequest([
      ['CalendarEvent/query', {
        accountId: this.session!.accountId,
        filter,
        limit,
        sort: [{ property: 'start', isAscending: false }],
      }, 'a'],
      ['CalendarEvent/get', {
        accountId: this.session!.accountId,
        '#ids': {
          resultOf: 'a',
          name: 'CalendarEvent/query',
          path: '/ids',
        },
        properties: ['id', 'title', 'description', 'start', 'end', 'calendarId', 'location', 'participants', 'status', 'showWithoutTime'],
      }, 'b']
    ]);

    return {
      queryResult: response.methodResponses[0][1],
      eventsResult: response.methodResponses[1][1]
    };
  }

  async createCalendarEvent(eventData: {
    calendarId: string;
    title: string;
    description?: string;
    start: string;
    end: string;
    location?: string;
    participants?: string[];
    showWithoutTime?: boolean;
  }): Promise<any> {
    const event = {
      calendarId: eventData.calendarId,
      title: eventData.title,
      description: eventData.description || '',
      start: eventData.start,
      end: eventData.end,
      location: eventData.location || '',
      showWithoutTime: eventData.showWithoutTime || false,
      participants: eventData.participants ? eventData.participants.map(email => ({
        email,
        role: 'attendee',
        participationStatus: 'needs-action',
      })) : [],
    };

    const response = await this.jmapRequest([
      ['CalendarEvent/set', {
        accountId: this.session!.accountId,
        create: {
          tempId: event,
        },
      }, 'a']
    ]);

    return response.methodResponses[0][1];
  }

  async updateCalendarEvent(eventId: string, updates: {
    title?: string;
    description?: string;
    start?: string;
    end?: string;
    location?: string;
    participants?: string[];
  }): Promise<any> {
    const updateData: any = {};
    if (updates.title !== undefined) updateData.title = updates.title;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.start !== undefined) updateData.start = updates.start;
    if (updates.end !== undefined) updateData.end = updates.end;
    if (updates.location !== undefined) updateData.location = updates.location;
    if (updates.participants !== undefined) {
      updateData.participants = updates.participants.map(email => ({
        email,
        role: 'attendee',
        participationStatus: 'needs-action',
      }));
    }

    const response = await this.jmapRequest([
      ['CalendarEvent/set', {
        accountId: this.session!.accountId,
        update: {
          [eventId]: updateData,
        },
      }, 'a']
    ]);

    return response.methodResponses[0][1];
  }

  async deleteCalendarEvent(eventId: string): Promise<any> {
    const response = await this.jmapRequest([
      ['CalendarEvent/set', {
        accountId: this.session!.accountId,
        destroy: [eventId],
      }, 'a']
    ]);

    return response.methodResponses[0][1];
  }

  // Contact methods
  async getAddressBooks(): Promise<any> {
    const response = await this.jmapRequest([
      ['AddressBook/get', {
        accountId: this.session!.accountId,
      }, 'a']
    ]);

    return response.methodResponses[0][1];
  }

  async getContacts(addressBookId?: string, limit: number = 50): Promise<any> {
    const filter: any = {};
    if (addressBookId) {
      filter.inAddressBook = addressBookId;
    }

    const response = await this.jmapRequest([
      ['Contact/query', {
        accountId: this.session!.accountId,
        filter,
        limit,
        sort: [{ property: 'lastName', isAscending: true }],
      }, 'a'],
      ['Contact/get', {
        accountId: this.session!.accountId,
        '#ids': {
          resultOf: 'a',
          name: 'Contact/query',
          path: '/ids',
        },
        properties: ['id', 'firstName', 'lastName', 'emails', 'phones', 'addresses', 'company', 'jobTitle', 'notes', 'addressBookId'],
      }, 'b']
    ]);

    return {
      queryResult: response.methodResponses[0][1],
      contactsResult: response.methodResponses[1][1]
    };
  }

  async searchContacts(query: string, limit: number = 20): Promise<any> {
    const response = await this.jmapRequest([
      ['Contact/query', {
        accountId: this.session!.accountId,
        filter: {
          text: query,
        },
        limit,
        sort: [{ property: 'lastName', isAscending: true }],
      }, 'a'],
      ['Contact/get', {
        accountId: this.session!.accountId,
        '#ids': {
          resultOf: 'a',
          name: 'Contact/query',
          path: '/ids',
        },
        properties: ['id', 'firstName', 'lastName', 'emails', 'phones', 'addresses', 'company', 'jobTitle', 'notes', 'addressBookId'],
      }, 'b']
    ]);

    return {
      queryResult: response.methodResponses[0][1],
      contactsResult: response.methodResponses[1][1]
    };
  }

  async createContact(contactData: {
    addressBookId: string;
    firstName?: string;
    lastName?: string;
    emails?: { type: string; value: string }[];
    phones?: { type: string; value: string }[];
    addresses?: { type: string; street?: string; city?: string; state?: string; country?: string; postalCode?: string }[];
    company?: string;
    jobTitle?: string;
    notes?: string;
  }): Promise<any> {
    const contact = {
      addressBookId: contactData.addressBookId,
      firstName: contactData.firstName || '',
      lastName: contactData.lastName || '',
      emails: contactData.emails || [],
      phones: contactData.phones || [],
      addresses: contactData.addresses || [],
      company: contactData.company || '',
      jobTitle: contactData.jobTitle || '',
      notes: contactData.notes || '',
    };

    const response = await this.jmapRequest([
      ['Contact/set', {
        accountId: this.session!.accountId,
        create: {
          tempId: contact,
        },
      }, 'a']
    ]);

    return response.methodResponses[0][1];
  }

  async updateContact(contactId: string, updates: {
    firstName?: string;
    lastName?: string;
    emails?: { type: string; value: string }[];
    phones?: { type: string; value: string }[];
    addresses?: { type: string; street?: string; city?: string; state?: string; country?: string; postalCode?: string }[];
    company?: string;
    jobTitle?: string;
    notes?: string;
  }): Promise<any> {
    const updateData: any = {};
    Object.keys(updates).forEach(key => {
      if ((updates as any)[key] !== undefined) {
        updateData[key] = (updates as any)[key];
      }
    });

    const response = await this.jmapRequest([
      ['Contact/set', {
        accountId: this.session!.accountId,
        update: {
          [contactId]: updateData,
        },
      }, 'a']
    ]);

    return response.methodResponses[0][1];
  }

  async deleteContact(contactId: string): Promise<any> {
    const response = await this.jmapRequest([
      ['Contact/set', {
        accountId: this.session!.accountId,
        destroy: [contactId],
      }, 'a']
    ]);

    return response.methodResponses[0][1];
  }
}

class JmapMCPServer {
  private server: Server;
  private client: JmapJMAPClient | null = null;
  private initPromise: Promise<void>;
  private isInitialized: boolean = false;

  constructor() {
    this.server = new Server(
      {
        name: 'jmap-server',
        version: '0.1.0',
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize connection asynchronously
    this.initPromise = this.initializeFromEnv();
    this.setupToolHandlers();
  }

  private async initializeFromEnv(): Promise<void> {
    try {
      console.error('=== MCP Server Initialization ===');
      console.error('Environment variables check:');
      console.error(`JMAP_BASE_URL: ${process.env.JMAP_BASE_URL ? 'SET' : 'NOT SET'}`);
      console.error(`JMAP_USERNAME: ${process.env.JMAP_USERNAME ? 'SET' : 'NOT SET'}`);
      console.error(`JMAP_PASSWORD: ${process.env.JMAP_PASSWORD ? 'SET' : 'NOT SET'}`);
      console.error(`JMAP_ACCOUNT_ID: ${process.env.JMAP_ACCOUNT_ID ? 'SET' : 'NOT SET'}`);
      
      let config: JmapConfig | null = null;

      // Try to create default config from environment variables first
      config = createDefaultConfig();
      
      if (config) {
        console.error('✅ Using environment variables for configuration');
        console.error(`Base URL: ${config.baseUrl}`);
        console.error(`Username: ${config.username}`);
        if (config.accountId) {
          console.error(`Account ID: ${config.accountId}`);
        }
      } else {
        console.error('❌ Environment variables not complete, trying config files...');
        // Try config file
        const configPaths = [
          process.env.JMAP_CONFIG_PATH,
          resolve(process.cwd(), 'jmap-config.json'),
          resolve(process.env.HOME || '~', '.jmap-config.json'),
        ].filter(Boolean) as string[];

        for (const configPath of configPaths) {
          if (existsSync(configPath)) {
            try {
              const configData = readFileSync(configPath, 'utf8');
              config = JSON.parse(configData);
              console.error(`Loaded config from ${configPath}`);
              break;
            } catch (error) {
              console.error(`Failed to read config from ${configPath}: ${error}`);
            }
          }
        }
      }

      if (config?.baseUrl && config?.username && config?.password) {
        console.error(`Attempting connection to ${config.baseUrl} as ${config.username}`);
        try {
          this.client = new JmapJMAPClient(config);
          
          // Test connection
          await this.client.getMailboxes();
          this.isInitialized = true;
          console.error(`✅ Auto-connected to Jmap Mail server at ${config.baseUrl} as ${config.username}`);
        } catch (error) {
          console.error(`❌ Failed to auto-connect to Jmap server: ${error instanceof Error ? error.message : String(error)}`);
          this.client = null;
          this.isInitialized = false;
        }
      } else {
        console.error('❌ No valid configuration found');
        this.isInitialized = false;
      }
    } catch (error) {
      console.error(`❌ Initialization error: ${error}`);
      this.isInitialized = false;
    }
  }

  private async ensureInitialized(): Promise<void> {
    await this.initPromise;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'connect_jmap',
            description: 'Connect to Jmap Mail server using JMAP, Calling this function is completely optional as connection to jmap server actually is automaticly done by default',
            inputSchema: {
              type: 'object',
              properties: {
                baseUrl: {
                  type: 'string',
                  description: 'Base URL of the Jmap Mail server (e.g., https://mail.example.com)',
                },
                username: {
                  type: 'string',
                  description: 'Username/email for authentication',
                },
                password: {
                  type: 'string',
                  description: 'Password for authentication',
                },
              },
              required: ['baseUrl', 'username', 'password'],
            },
          },
          {
            name: 'get_mailboxes',
            description: 'Get all mailboxes from the mail server',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_emails',
            description: 'Get emails from a mailbox',
            inputSchema: {
              type: 'object',
              properties: {
                mailboxId: {
                  type: 'string',
                  description: 'Mailbox ID or name (e.g., "Inbox", "Sent", "M001abc123"). If not specified, gets all emails.',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of emails to retrieve (default: 50)',
                },
              },
            },
          },
          {
            name: 'get_email_by_id',
            description: 'Get a specific email by its ID',
            inputSchema: {
              type: 'object',
              properties: {
                emailId: {
                  type: 'string',
                  description: 'Email ID',
                },
              },
              required: ['emailId'],
            },
          },
          {
            name: 'search_emails',
            description: 'Search emails by text query',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of results (default: 20)',
                },
                mailboxId: {
                  type: 'string',
                  description: 'Search within specific mailbox (name or ID, optional)',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'send_email',
            description: 'Send an email',
            inputSchema: {
              type: 'object',
              properties: {
                to: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Recipient email addresses',
                },
                subject: {
                  type: 'string',
                  description: 'Email subject',
                },
                textBody: {
                  type: 'string',
                  description: 'Plain text body',
                },
                htmlBody: {
                  type: 'string',
                  description: 'HTML body',
                },
                cc: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'CC recipients',
                },
                bcc: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'BCC recipients',
                },
                inReplyTo: {
                  type: 'string',
                  description: 'Message ID this is replying to',
                },
                references: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Reference message IDs',
                },
              },
              required: ['to', 'subject'],
            },
          },
          {
            name: 'mark_as_read',
            description: 'Mark emails as read',
            inputSchema: {
              type: 'object',
              properties: {
                emailIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of email IDs to mark as read',
                },
              },
              required: ['emailIds'],
            },
          },
          {
            name: 'mark_as_unread',
            description: 'Mark emails as unread',
            inputSchema: {
              type: 'object',
              properties: {
                emailIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of email IDs to mark as unread',
                },
              },
              required: ['emailIds'],
            },
          },
          {
            name: 'delete_emails',
            description: 'Delete emails (move to trash)',
            inputSchema: {
              type: 'object',
              properties: {
                emailIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of email IDs to delete',
                },
              },
              required: ['emailIds'],
            },
          },
          // Calendar tools
          {
            name: 'get_calendars',
            description: 'Get all calendars from the server',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_calendar_events',
            description: 'Get calendar events from a specific calendar or all calendars',
            inputSchema: {
              type: 'object',
              properties: {
                calendarId: {
                  type: 'string',
                  description: 'Calendar ID to get events from. If not specified, gets events from all calendars.',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of events to retrieve (default: 50)',
                },
              },
            },
          },
          {
            name: 'create_calendar_event',
            description: 'Create a new calendar event',
            inputSchema: {
              type: 'object',
              properties: {
                calendarId: {
                  type: 'string',
                  description: 'Calendar ID to create the event in',
                },
                title: {
                  type: 'string',
                  description: 'Event title',
                },
                description: {
                  type: 'string',
                  description: 'Event description',
                },
                start: {
                  type: 'string',
                  description: 'Event start time in ISO 8601 format (e.g., "2024-01-15T10:00:00Z")',
                },
                end: {
                  type: 'string',
                  description: 'Event end time in ISO 8601 format (e.g., "2024-01-15T11:00:00Z")',
                },
                location: {
                  type: 'string',
                  description: 'Event location',
                },
                participants: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Email addresses of event participants',
                },
                showWithoutTime: {
                  type: 'boolean',
                  description: 'Whether this is an all-day event (default: false)',
                },
              },
              required: ['calendarId', 'title', 'start', 'end'],
            },
          },
          {
            name: 'update_calendar_event',
            description: 'Update an existing calendar event',
            inputSchema: {
              type: 'object',
              properties: {
                eventId: {
                  type: 'string',
                  description: 'Event ID to update',
                },
                title: {
                  type: 'string',
                  description: 'New event title',
                },
                description: {
                  type: 'string',
                  description: 'New event description',
                },
                start: {
                  type: 'string',
                  description: 'New event start time in ISO 8601 format',
                },
                end: {
                  type: 'string',
                  description: 'New event end time in ISO 8601 format',
                },
                location: {
                  type: 'string',
                  description: 'New event location',
                },
                participants: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'New email addresses of event participants',
                },
              },
              required: ['eventId'],
            },
          },
          {
            name: 'delete_calendar_event',
            description: 'Delete a calendar event',
            inputSchema: {
              type: 'object',
              properties: {
                eventId: {
                  type: 'string',
                  description: 'Event ID to delete',
                },
              },
              required: ['eventId'],
            },
          },
          // Contact tools
          {
            name: 'get_address_books',
            description: 'Get all address books from the server',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_contacts',
            description: 'Get contacts from a specific address book or all address books',
            inputSchema: {
              type: 'object',
              properties: {
                addressBookId: {
                  type: 'string',
                  description: 'Address book ID to get contacts from. If not specified, gets contacts from all address books.',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of contacts to retrieve (default: 50)',
                },
              },
            },
          },
          {
            name: 'search_contacts',
            description: 'Search contacts by text query',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query to find contacts',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of results (default: 20)',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'create_contact',
            description: 'Create a new contact',
            inputSchema: {
              type: 'object',
              properties: {
                addressBookId: {
                  type: 'string',
                  description: 'Address book ID to create the contact in',
                },
                firstName: {
                  type: 'string',
                  description: 'Contact first name',
                },
                lastName: {
                  type: 'string',
                  description: 'Contact last name',
                },
                emails: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: 'Email type (e.g., "work", "home", "personal")' },
                      value: { type: 'string', description: 'Email address' },
                    },
                    required: ['type', 'value'],
                  },
                  description: 'Contact email addresses',
                },
                phones: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: 'Phone type (e.g., "work", "home", "mobile")' },
                      value: { type: 'string', description: 'Phone number' },
                    },
                    required: ['type', 'value'],
                  },
                  description: 'Contact phone numbers',
                },
                addresses: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: 'Address type (e.g., "work", "home")' },
                      street: { type: 'string', description: 'Street address' },
                      city: { type: 'string', description: 'City' },
                      state: { type: 'string', description: 'State/Province' },
                      country: { type: 'string', description: 'Country' },
                      postalCode: { type: 'string', description: 'Postal/ZIP code' },
                    },
                    required: ['type'],
                  },
                  description: 'Contact addresses',
                },
                company: {
                  type: 'string',
                  description: 'Contact company/organization',
                },
                jobTitle: {
                  type: 'string',
                  description: 'Contact job title',
                },
                notes: {
                  type: 'string',
                  description: 'Contact notes',
                },
              },
              required: ['addressBookId'],
            },
          },
          {
            name: 'update_contact',
            description: 'Update an existing contact',
            inputSchema: {
              type: 'object',
              properties: {
                contactId: {
                  type: 'string',
                  description: 'Contact ID to update',
                },
                firstName: {
                  type: 'string',
                  description: 'New contact first name',
                },
                lastName: {
                  type: 'string',
                  description: 'New contact last name',
                },
                emails: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: 'Email type (e.g., "work", "home", "personal")' },
                      value: { type: 'string', description: 'Email address' },
                    },
                    required: ['type', 'value'],
                  },
                  description: 'New contact email addresses',
                },
                phones: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: 'Phone type (e.g., "work", "home", "mobile")' },
                      value: { type: 'string', description: 'Phone number' },
                    },
                    required: ['type', 'value'],
                  },
                  description: 'New contact phone numbers',
                },
                addresses: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: 'Address type (e.g., "work", "home")' },
                      street: { type: 'string', description: 'Street address' },
                      city: { type: 'string', description: 'City' },
                      state: { type: 'string', description: 'State/Province' },
                      country: { type: 'string', description: 'Country' },
                      postalCode: { type: 'string', description: 'Postal/ZIP code' },
                    },
                    required: ['type'],
                  },
                  description: 'New contact addresses',
                },
                company: {
                  type: 'string',
                  description: 'New contact company/organization',
                },
                jobTitle: {
                  type: 'string',
                  description: 'New contact job title',
                },
                notes: {
                  type: 'string',
                  description: 'New contact notes',
                },
              },
              required: ['contactId'],
            },
          },
          {
            name: 'delete_contact',
            description: 'Delete a contact',
            inputSchema: {
              type: 'object',
              properties: {
                contactId: {
                  type: 'string',
                  description: 'Contact ID to delete',
                },
              },
              required: ['contactId'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'connect_jmap':
            return await this.handleConnect(request.params.arguments);
          
          case 'get_mailboxes':
            return await this.handleGetMailboxes();
          
          case 'get_emails':
            return await this.handleGetEmails(request.params.arguments);
          
          case 'get_email_by_id':
            return await this.handleGetEmailById(request.params.arguments);
          
          case 'search_emails':
            return await this.handleSearchEmails(request.params.arguments);
          
          case 'send_email':
            return await this.handleSendEmail(request.params.arguments);
          
          case 'mark_as_read':
            return await this.handleMarkAsRead(request.params.arguments);
          
          case 'mark_as_unread':
            return await this.handleMarkAsUnread(request.params.arguments);
          
          case 'delete_emails':
            return await this.handleDeleteEmails(request.params.arguments);
          
          // Calendar handlers
          case 'get_calendars':
            return await this.handleGetCalendars();
          
          case 'get_calendar_events':
            return await this.handleGetCalendarEvents(request.params.arguments);
          
          case 'create_calendar_event':
            return await this.handleCreateCalendarEvent(request.params.arguments);
          
          case 'update_calendar_event':
            return await this.handleUpdateCalendarEvent(request.params.arguments);
          
          case 'delete_calendar_event':
            return await this.handleDeleteCalendarEvent(request.params.arguments);
          
          // Contact handlers
          case 'get_address_books':
            return await this.handleGetAddressBooks();
          
          case 'get_contacts':
            return await this.handleGetContacts(request.params.arguments);
          
          case 'search_contacts':
            return await this.handleSearchContacts(request.params.arguments);
          
          case 'create_contact':
            return await this.handleCreateContact(request.params.arguments);
          
          case 'update_contact':
            return await this.handleUpdateContact(request.params.arguments);
          
          case 'delete_contact':
            return await this.handleDeleteContact(request.params.arguments);
          
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private async handleConnect(args: any) {
    const { baseUrl, username, password } = args;
    
    this.client = new JmapJMAPClient({
      baseUrl,
      username,
      password,
    });

    // Test connection
    await this.client.getMailboxes();
    this.isInitialized = true;

    return {
      content: [
        {
          type: 'text',
          text: `Successfully connected to Jmap Mail server at ${baseUrl}`,
        },
      ],
    };
  }

  private async handleGetMailboxes() {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const mailboxes = await this.client.getMailboxes();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(mailboxes, null, 2),
        },
      ],
    };
  }

  private async handleGetEmails(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { mailboxId, limit = 50 } = args || {};
    const result = await this.client.getEmails(mailboxId, limit);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleGetEmailById(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { emailId } = args;
    const result = await this.client.getEmailById(emailId);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleSearchEmails(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { query, limit = 20, mailboxId } = args;
    const result = await this.client.searchEmails(query, limit, mailboxId);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleSendEmail(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const result = await this.client.sendEmail(args);
    
    return {
      content: [
        {
          type: 'text',
          text: `Email sent successfully: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async handleMarkAsRead(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { emailIds } = args;
    const result = await this.client.markAsRead(emailIds);
    
    return {
      content: [
        {
          type: 'text',
          text: `Marked ${emailIds.length} emails as read: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async handleMarkAsUnread(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { emailIds } = args;
    const result = await this.client.markAsUnread(emailIds);
    
    return {
      content: [
        {
          type: 'text',
          text: `Marked ${emailIds.length} emails as unread: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async handleDeleteEmails(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { emailIds } = args;
    const result = await this.client.deleteEmails(emailIds);
    
    return {
      content: [
        {
          type: 'text',
          text: `Deleted ${emailIds.length} emails: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  // Calendar handlers
  private async handleGetCalendars() {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const calendars = await this.client.getCalendars();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(calendars, null, 2),
        },
      ],
    };
  }

  private async handleGetCalendarEvents(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { calendarId, limit = 50 } = args || {};
    const result = await this.client.getCalendarEvents(calendarId, limit);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleCreateCalendarEvent(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const result = await this.client.createCalendarEvent(args);
    
    return {
      content: [
        {
          type: 'text',
          text: `Calendar event created successfully: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async handleUpdateCalendarEvent(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { eventId, ...updates } = args;
    const result = await this.client.updateCalendarEvent(eventId, updates);
    
    return {
      content: [
        {
          type: 'text',
          text: `Calendar event updated successfully: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async handleDeleteCalendarEvent(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { eventId } = args;
    const result = await this.client.deleteCalendarEvent(eventId);
    
    return {
      content: [
        {
          type: 'text',
          text: `Calendar event deleted successfully: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  // Contact handlers
  private async handleGetAddressBooks() {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const addressBooks = await this.client.getAddressBooks();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(addressBooks, null, 2),
        },
      ],
    };
  }

  private async handleGetContacts(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { addressBookId, limit = 50 } = args || {};
    const result = await this.client.getContacts(addressBookId, limit);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleSearchContacts(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { query, limit = 20 } = args;
    const result = await this.client.searchContacts(query, limit);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleCreateContact(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const result = await this.client.createContact(args);
    
    return {
      content: [
        {
          type: 'text',
          text: `Contact created successfully: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async handleUpdateContact(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { contactId, ...updates } = args;
    const result = await this.client.updateContact(contactId, updates);
    
    return {
      content: [
        {
          type: 'text',
          text: `Contact updated successfully: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async handleDeleteContact(args: any) {
    await this.ensureInitialized();
    
    if (!this.client || !this.isInitialized) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to Jmap Mail server. Please use the connect_jmap tool first with your server details.',
          },
        ],
      };
    }

    const { contactId } = args;
    const result = await this.client.deleteContact(contactId);
    
    return {
      content: [
        {
          type: 'text',
          text: `Contact deleted successfully: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Jmap Mail MCP server running on stdio');
  }
}

const server = new JmapMCPServer();
server.run().catch(console.error);

#!/usr/bin/env node

/**
 * Quick Test Script for JMAP MCP Server
 * 
 * This script performs basic functionality tests without requiring full credentials
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = resolve(__dirname, '../dist/index.js');

async function quickTest() {
  console.log('🚀 Quick Test: Starting MCP Server...');
  
  const serverProcess = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Handle server output
  serverProcess.stderr.on('data', (data) => {
    console.log('📝 Server:', data.toString().trim());
  });

  // Test 1: List tools
  console.log('\n📋 Test 1: Listing available tools...');
  
  const listToolsRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  };

  return new Promise((resolve, reject) => {
    let responseData = '';
    
    const timeout = setTimeout(() => {
      serverProcess.kill();
      reject(new Error('Timeout waiting for response'));
    }, 10000);

    serverProcess.stdout.on('data', (data) => {
      responseData += data.toString();
      
      try {
        const response = JSON.parse(responseData.trim());
        if (response.id === 1) {
          clearTimeout(timeout);
          
          if (response.error) {
            console.error('❌ Error:', response.error.message);
            reject(new Error(response.error.message));
          } else {
            console.log('✅ Tools found:');
            response.result.tools.forEach(tool => {
              console.log(`   • ${tool.name}: ${tool.description}`);
            });
            
            console.log(`\n🎉 Quick test passed! Found ${response.result.tools.length} tools.`);
            serverProcess.kill();
            resolve(response.result);
          }
        }
      } catch (e) {
        // Not complete JSON yet
      }
    });

    // Wait a moment for server to start, then send request
    setTimeout(() => {
      serverProcess.stdin.write(JSON.stringify(listToolsRequest) + '\n');
    }, 1000);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  quickTest()
    .then(() => {
      console.log('\n✅ Quick test completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Quick test failed:', error.message);
      process.exit(1);
    });
}


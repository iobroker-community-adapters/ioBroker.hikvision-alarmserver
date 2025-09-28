# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

## Adapter-Specific Context
- **Adapter Name**: iobroker.hikvision-alarmserver
- **Primary Function**: An adapter to receive alarms/events sent from Hikvision cameras
- **Key Technologies**: HTTP server, XML parsing, multipart message handling, image processing
- **Target Devices**: Hikvision IP cameras (DS-2CD series, DS-2DE series)
- **Communication Protocol**: HTTP POST with XML payloads and binary image attachments
- **Key Dependencies**: @iobroker/adapter-core, xml2js, parse-multipart-data, canvas, fs-extra
- **Configuration Requirements**: Network binding address/port, alarm timeout, channel management, image/XML saving options, sendTo integration

### Unique Requirements
- **Multipart Message Processing**: Handle HTTP multipart messages containing both XML metadata and binary image data
- **Real-time Event Processing**: Process continuous alarm streams with automatic timeout/clearing logic
- **Image Annotation**: Capability to annotate images with detection rectangles using Canvas API
- **sendTo Integration**: Forward events and images to other ioBroker adapters (Telegram, JavaScript, etc.)
- **MAC Address Based Identification**: Use camera MAC addresses for device identification and state tree organization
- **XML Event Parsing**: Parse complex XML event structures with nested detection targets and channel information

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties
                        Object.assign(obj.native, {
                            position: TEST_COORDINATES,
                            createCurrently: true,
                            createHourly: true,
                            createDaily: true,
                            // Add other configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Check for successful states creation
                        const states = await harness.getAllStates();
                        
                        console.log('📊 Available states:');
                        Object.keys(states).forEach(key => {
                            if (key.startsWith('your-adapter.0.')) {
                                console.log(`   ${key}: ${JSON.stringify(states[key])}`);
                            }
                        });

                        // Validate expected states exist
                        const expectedStates = [
                            'your-adapter.0.info.connection',
                            // Add other expected states
                        ];
                        
                        const missingStates = expectedStates.filter(stateId => !states[stateId]);
                        if (missingStates.length > 0) {
                            return reject(new Error(`Missing expected states: ${missingStates.join(', ')}`));
                        }

                        console.log('✅ Step 4: All expected states found');
                        resolve();
                        
                    } catch (error) {
                        console.error('❌ Integration test failed:', error.message);
                        reject(error);
                    }
                });
            }).timeout(30000);
        });
    }
});
```

#### Practical Example: Testing with Demo Data
For adapters like the Hikvision alarm server that receive external data, create test files:

```javascript
// test/integration.js
const path = require('path');
const { tests } = require('@iobroker/testing');
const http = require('http');

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Hikvision Alarm Server Integration', (getHarness) => {
            let harness;
            let testServer;

            before(() => {
                harness = getHarness();
            });

            it('should process alarm events from cameras', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        // Configure adapter for testing
                        const obj = await harness.objects.getObjectAsync('system.adapter.hikvision-alarmserver.0');
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        Object.assign(obj.native, {
                            bind: '127.0.0.1',
                            port: 8089,
                            alarmTimeout: 5000,
                            useChannels: false,
                            useDetectionTargets: false
                        });

                        await harness.objects.setObjectAsync(obj._id, obj);
                        
                        // Start adapter
                        await harness.startAdapterAndWait();
                        
                        // Wait for HTTP server to start
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // Send test alarm event
                        const testXML = `<?xml version="1.0" encoding="UTF-8"?>
                        <EventNotificationAlert>
                            <ipAddress>192.168.1.100</ipAddress>
                            <macAddress>aa:bb:cc:dd:ee:ff</macAddress>
                            <dateTime>2023-01-24T10:00:00+00:00</dateTime>
                            <eventType>VMD</eventType>
                        </EventNotificationAlert>`;

                        const postData = testXML;
                        const options = {
                            hostname: '127.0.0.1',
                            port: 8089,
                            path: '/',
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/xml',
                                'Content-Length': Buffer.byteLength(postData)
                            }
                        };

                        // Send test event
                        const req = http.request(options, (res) => {
                            console.log('Test event sent, status:', res.statusCode);
                        });

                        req.on('error', (err) => {
                            reject(new Error(`Test event failed: ${err.message}`));
                        });

                        req.write(postData);
                        req.end();

                        // Wait for processing
                        await new Promise(resolve => setTimeout(resolve, 2000));

                        // Check for created states
                        const states = await harness.getAllStates();
                        const alarmState = states['hikvision-alarmserver.0.aabbccddeeff.VMD'];
                        
                        if (!alarmState || alarmState.val !== true) {
                            return reject(new Error('Expected alarm state not found or not true'));
                        }

                        console.log('✅ Alarm event processed successfully');
                        resolve();

                    } catch (error) {
                        console.error('❌ Integration test failed:', error.message);
                        reject(error);
                    }
                });
            }).timeout(15000);
        });
    }
});
```

## Core Patterns

### Adapter Initialization
```javascript
class HikvisionAlarmServer extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'hikvision-alarmserver',
    });
    
    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    // Initialize HTTP server
    this.startServer();
    
    // Set connection state
    await this.setStateAsync('info.connection', false, true);
  }

  onUnload(callback) {
    try {
      // Clean up HTTP server
      if (this.server) {
        this.server.close();
        this.server = null;
      }
      
      // Clear timers
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = undefined;
      }
      
      callback();
    } catch (e) {
      callback();
    }
  }
}
```

### State Management
```javascript
// Create device and state structure
await this.setObjectNotExistsAsync(`${deviceId}.${eventType}`, {
  type: 'state',
  common: {
    name: `${eventType} alarm`,
    type: 'boolean',
    role: 'sensor.alarm',
    read: true,
    write: false
  },
  native: {}
});

// Set state with timestamp
await this.setStateAsync(`${deviceId}.${eventType}`, {
  val: true,
  ts: Date.now(),
  ack: true
});
```

### HTTP Server Implementation
```javascript
startServer() {
  const http = require('http');
  
  this.server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      this.handleAlarmEvent(req, res);
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }
  });

  this.server.listen(this.config.port, this.config.bind, () => {
    this.log.info(`Alarm server listening on ${this.config.bind}:${this.config.port}`);
  });
}
```

### XML Processing
```javascript
async parseXmlEvent(xmlData) {
  const xml2js = require('xml2js');
  const parser = new xml2js.Parser();
  
  try {
    const result = await parser.parseStringPromise(xmlData);
    return result.EventNotificationAlert;
  } catch (error) {
    this.log.error(`XML parsing failed: ${error.message}`);
    return null;
  }
}
```

### Multipart Message Handling
```javascript
async handleMultipartMessage(req, res) {
  const parseMultipartData = require('parse-multipart-data');
  
  const boundary = this.extractBoundary(req.headers['content-type']);
  if (!boundary) {
    this.log.error('No boundary found in Content-Type header');
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString('binary');
  });

  req.on('end', async () => {
    try {
      const buffer = Buffer.from(body, 'binary');
      const parts = parseMultipartData(buffer, boundary);
      
      for (const part of parts) {
        if (part.type && part.type.includes('xml')) {
          await this.processXmlPart(part.data);
        } else if (part.type && part.type.includes('image')) {
          await this.processImagePart(part.data);
        }
      }
      
      res.writeHead(200);
      res.end();
    } catch (error) {
      this.log.error(`Multipart processing failed: ${error.message}`);
      res.writeHead(500);
      res.end();
    }
  });
}
```

## Logging

Use appropriate ioBroker logging levels:

```javascript
// Error - for critical issues that prevent functionality
this.log.error('Failed to start HTTP server: ' + error.message);

// Warning - for non-critical issues that should be noted
this.log.warn('Invalid XML received from camera ' + ipAddress);

// Info - for important operational information
this.log.info('Alarm server started on port ' + this.config.port);

// Debug - for detailed troubleshooting information
this.log.debug('Received alarm event: ' + JSON.stringify(eventData));
```

## Error Handling

Implement comprehensive error handling:

```javascript
async processAlarmEvent(eventData) {
  try {
    // Validate event data
    if (!eventData.macAddress) {
      throw new Error('Missing macAddress in event data');
    }

    // Process event
    await this.createAlarmState(eventData);
    
  } catch (error) {
    this.log.error(`Event processing failed: ${error.message}`);
    // Continue operation, don't crash adapter
  }
}
```

## Configuration Management

Handle adapter configuration properly:

```javascript
onReady() {
  // Validate configuration
  if (!this.config.port || this.config.port < 1 || this.config.port > 65535) {
    this.log.error('Invalid port configuration');
    return;
  }

  // Use configuration values
  this.alarmTimeout = this.config.alarmTimeout || 5000;
  this.bindAddress = this.config.bind || '0.0.0.0';
}
```

## sendTo Integration

Implement message forwarding to other adapters:

```javascript
async forwardEvent(eventContext) {
  if (this.config.sendXmlInstance) {
    try {
      const message = this.evaluateMessageTemplate(
        this.config.sendXmlMessage, 
        eventContext
      );
      
      await this.sendToAsync(
        this.config.sendXmlInstance,
        this.config.sendXmlCommand || '',
        message
      );
      
    } catch (error) {
      this.log.error(`sendTo failed: ${error.message}`);
    }
  }
}

evaluateMessageTemplate(template, context) {
  // Safely evaluate template with context
  const func = new Function('ctx', 'imageBuffer', `return ${template}`);
  return func(context, context.imageBuffer);
}
```

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

## CI/CD and Testing Integration

### GitHub Actions for API Testing
For adapters with external API dependencies, implement separate CI/CD jobs:

```yaml
# Tests API connectivity with demo credentials (runs separately)
demo-api-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run demo API tests
      run: npm run test:integration-demo
```

### CI/CD Best Practices
- Run credential tests separately from main test suite
- Use ubuntu-22.04 for consistency
- Don't make credential tests required for deployment
- Provide clear failure messages for API connectivity issues
- Use appropriate timeouts for external API calls (120+ seconds)

### Package.json Script Integration
Add dedicated script for credential testing:
```json
{
  "scripts": {
    "test:integration-demo": "mocha test/integration-demo --exit"
  }
}
```

### Practical Example: Complete API Testing Implementation
Here's a complete example based on lessons learned from the Discovergy adapter:

#### test/integration-demo.js
```javascript
const path = require("path");
const { tests } = require("@iobroker/testing");

// Helper function to encrypt password using ioBroker's encryption method
async function encryptPassword(harness, password) {
    const systemConfig = await harness.objects.getObjectAsync("system.config");
    
    if (!systemConfig || !systemConfig.native || !systemConfig.native.secret) {
        throw new Error("Could not retrieve system secret for password encryption");
    }
    
    const secret = systemConfig.native.secret;
    let result = '';
    for (let i = 0; i < password.length; ++i) {
        result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ password.charCodeAt(i));
    }
    
    return result;
}

// Run integration tests with demo credentials
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("API Testing with Demo Credentials", (getHarness) => {
            let harness;
            
            before(() => {
                harness = getHarness();
            });

            it("Should connect to API and initialize with demo credentials", async () => {
                console.log("Setting up demo credentials...");
                
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                
                const encryptedPassword = await encryptPassword(harness, "demo_password");
                
                await harness.changeAdapterConfig("your-adapter", {
                    native: {
                        username: "demo@provider.com",
                        password: encryptedPassword,
                        // other config options
                    }
                });

                console.log("Starting adapter with demo credentials...");
                await harness.startAdapter();
                
                // Wait for API calls and initialization
                await new Promise(resolve => setTimeout(resolve, 60000));
                
                const connectionState = await harness.states.getStateAsync("your-adapter.0.info.connection");
                
                if (connectionState && connectionState.val === true) {
                    console.log("✅ SUCCESS: API connection established");
                    return true;
                } else {
                    throw new Error("API Test Failed: Expected API connection to be established with demo credentials. " +
                        "Check logs above for specific API errors (DNS resolution, 401 Unauthorized, network issues, etc.)");
                }
            }).timeout(120000);
        });
    }
});
```

## Specialized Patterns for Hikvision Alarm Server

### MAC Address Processing
```javascript
// Normalize MAC address for state IDs
normalizeMacAddress(macAddress) {
  return macAddress.replace(/:/g, '').toLowerCase();
}

// Create device structure based on MAC address
async createDeviceStructure(macAddress, deviceInfo) {
  const deviceId = this.normalizeMacAddress(macAddress);
  
  await this.setObjectNotExistsAsync(deviceId, {
    type: 'device',
    common: {
      name: deviceInfo.name || `Camera ${macAddress}`,
      statusStates: {
        onlineId: `${deviceId}.info.connection`
      }
    },
    native: {
      macAddress: macAddress,
      ipAddress: deviceInfo.ipAddress
    }
  });
}
```

### Alarm Timeout Management
```javascript
// Auto-clear alarms after timeout
scheduleAlarmClear(deviceId, eventType) {
  const timeoutKey = `${deviceId}_${eventType}`;
  
  // Clear existing timeout
  if (this.alarmTimeouts[timeoutKey]) {
    clearTimeout(this.alarmTimeouts[timeoutKey]);
  }
  
  // Set new timeout
  this.alarmTimeouts[timeoutKey] = setTimeout(async () => {
    await this.setStateAsync(`${deviceId}.${eventType}`, false, true);
    delete this.alarmTimeouts[timeoutKey];
    
    this.log.debug(`Auto-cleared alarm ${eventType} for device ${deviceId}`);
  }, this.config.alarmTimeout);
}
```

### Image Processing with Canvas
```javascript
async annotateImage(imageBuffer, detectionData) {
  const { createCanvas, loadImage } = require('canvas');
  
  try {
    const image = await loadImage(imageBuffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    
    // Draw original image
    ctx.drawImage(image, 0, 0);
    
    // Draw detection rectangles
    if (detectionData.targetRect) {
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 2;
      ctx.strokeRect(
        detectionData.targetRect.x * image.width,
        detectionData.targetRect.y * image.height,
        detectionData.targetRect.width * image.width,
        detectionData.targetRect.height * image.height
      );
    }
    
    return canvas.toBuffer('image/jpeg');
  } catch (error) {
    this.log.error(`Image annotation failed: ${error.message}`);
    return imageBuffer; // Return original on error
  }
}
```

This comprehensive configuration provides GitHub Copilot with deep understanding of ioBroker adapter development patterns, specialized knowledge for Hikvision camera integration, and practical examples for testing and implementation.
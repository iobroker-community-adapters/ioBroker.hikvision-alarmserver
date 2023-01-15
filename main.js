'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

const fs = require('fs-extra');
const path = require('node:path');

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const http = require('http');

const bodyMaxLogLength = 1536;

// TODO: awaiting release
// const parseStringPromise = require('xml2js').parseStringPromise;

// TODO: Workaround for https://github.com/Leonidas-from-XIV/node-xml2js/issues/601
const promisify = require('util').promisify;
const xml2js = require('xml2js');
const parseStringPromise = promisify(xml2js.parseString);

class HikvisionAlarmserver extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'hikvision-alarmserver',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.timers = [];
        this.server = null;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.dataDir = utils.getAbsoluteInstanceDataDir(this);
        this.log.debug('dataDir: ' + this.dataDir);

        const that = this;
        try {
            this.server = http.createServer(function (request, response) {
                if (request.method == 'POST') {
                    that.log.debug('Request headers: ' + JSON.stringify(request.headers));

                    let body = '';
                    request.on('data', function (data) {
                        body += data;
                    });
                    request.on('end', async function () {
                        that.dumpFile(body, 'request.txt');
                        if (!await that.decodePayload(request, body)) {
                            response.statusCode == 400; // Error
                        } else {
                            response.statusCode == 200; // Success
                        }
                        response.end();
                    });
                } else {
                    // Error
                    that.log.warn('Received non-POST request - ignoring');
                    response.statusCode = 400;
                    response.end();
                }
            });

            this.server.on('error', function (err) {
                that.log.error('HTTP server error: ' + err);
                that.terminate();
            });

            this.log.info('Server starting to listen on port ' + this.config.port + ((!this.config.bind || this.config.bind === '0.0.0.0') ? '' : ` (${this.config.bind})`));
            this.server.listen(this.config.port, (!this.config.bind || this.config.bind === '0.0.0.0') ? undefined : this.config.bind);
        } catch (err) {
            this.log.error('Caught error in HTTP server: ' + err);
            that.terminate();
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    async onUnload(callback) {
        try {
            if (this.server) {
                this.server.close();
                this.log.info('Closed server');
            }
            /* Clear any timers and set all to false immediately */
            Object.keys(this.timers).forEach(async (id) => {
                if (this.timers[id]) {
                    this.clearTimeout(this.timers[id]);
                    this.timers[id] = null;
                }
                await this.setStateAsync(id, false, true);
            });

            callback();
        } catch (e) {
            callback();
        }
    }

    async dumpFile(data, name) {
        const fileName = path.join(this.dataDir, name);
        this.log.debug(`Dumping ${data.length} bytes to ${fileName}`);
        try {
            await fs.outputFile(fileName, data, 'binary');
        } catch (err) {
            this.log.error(err);
            return false; // Error
        }
        return true; // Success
    }

    async decodePayload(request, body) {
        // Assume failure
        let success = false;

        if (body.length < bodyMaxLogLength) {
            this.log.debug(body);
        } else {
            this.log.debug(`Body length of ${body.length} is too large to log, first ${bodyMaxLogLength} bytes follow:\n` +
                body.substring(0, bodyMaxLogLength));
        }

        if (!('content-type' in request.headers)) {
            this.log.error('No content-type in header!');
        } else {
            const contentTypeParts = request.headers['content-type'].split(';');

            if (contentTypeParts[0] == 'application/xml') {
                // Payload was pure XML
                await this.logXmlEvent(body);
            } else if (contentTypeParts[0] == 'multipart/form-data') {
                const boundaries = request.headers['content-type'].match(new RegExp(' boundary=(.*)'));
                if (!boundaries || boundaries.length != 2) {
                    this.log.error('No boundary found in multipart header: ' + request.headers['content-type']);
                } else {
                    const boundary = boundaries[1];

                    // Couldn't get parse-multipart-data to work. Possible TODO: use that.
                    // In the mean time, just pull out with a regexp
                    // const xmlRe = new RegExp(`--${boundary}.*Content-Length:\\s*\\d{1,}\\s*(<.*?)--${boundary}(--){0,1}`, 's');
                    const parts = body.match(new RegExp(`^--${boundary}(.*?)(?=^--${boundary})`, 'gsm'));
                    if (!parts || !parts.length) {
                        this.log.error('Failed to extract parts from multipart payload');
                    } else {
                        // Got this far - assume success unless decode fails
                        success = true;
                        for (const part of parts) {
                            if (!await this.decodePart(part)) {
                                success = false;
                            }
                        }
                    }
                }
            } else {
                this.log.error('Unhandled content-type: ' + request.headers['content-type']);
            }

        }

        return success;
    }

    // Again, such a shame couldn't get parse-multipart-data to work. Possible TODO: use that.
    async decodePart(rawPart) {
        this.log.debug(JSON.stringify(rawPart.substring(0, 256)));
        // Hikvision cameras use \r\n for a newline
        const rawHeaders = rawPart.match(new RegExp('(.*?)(?:\r\n){2}(.*)', 's'));
        if (!rawHeaders || rawHeaders.length != 3) {
            this.log.error('No blank line break found in payload part');
        } else {
            const textHeaders = rawHeaders[1].match(new RegExp('(.*?:\s*.*?)(?:\r\n)', 'g'));
            if (!textHeaders || textHeaders.length == 0) {
                this.log.error('No headers found in payload part');
            } else {
                const headers = {};
                this.log.debug(JSON.stringify(textHeaders));
                for (const header of textHeaders) {
                    const headerParts = header.split(':');
                    if (headerParts.length != 2) {
                        this.log.error('Found malformed header');
                    } else {
                        this.log.debug(`Adding header ${headerParts[0].trim()}: ${headerParts[1].trim()}`);
                        headers[headerParts[0].trim()] = headerParts[1].trim();
                    }
                }
                this.log.debug(`Body length: ${rawHeaders[2].length} Headers: ${JSON.stringify(headers)}`);

                // Handle content types we know
                switch (headers['Content-Type']) {
                    case 'application/xml':
                        return this.logXmlEvent(rawHeaders[2]);
                        break;
                    case 'image/jpeg':
                        this.log.debug('jpeg: ' + JSON.stringify(rawHeaders[2].substring(0, 128)));
                        return this.dumpFile(rawHeaders[2], 'image.jpg');
                        break;
                    default:
                        this.log.warn('Unhandled content type: ' + headers['Content-Type']);
                }
            }
        }
    }

    async logXmlEvent(xmlString) {
        let success = false;
        try {
            const xmlObj = await parseStringPromise(xmlString);
            if (!xmlObj) {
                this.log.error('Parse returned null XML');
            } else {
                success = await this.logEvent(xmlObj);
            }
        } catch (err) {
            this.log.error('Error parsing XML: ' + err);
        }
        return success;
    }

    async logEvent(xml) {
        let macAddress = null;
        let eventType = null;
        try {
            // This is inside a try...catch so we handle case when XML was bad.
            // TODO: make object names configurable? Mac? IP? etc.
            macAddress = xml.EventNotificationAlert.macAddress[0];
            eventType = xml.EventNotificationAlert.eventType[0];
        } catch (err) {
            this.log.error('Bad request - failed to find required XML attributes');
            return false; // Error
        }

        // Channel name is optional
        const channelName = this.config.useChannels && xml.EventNotificationAlert?.channelName ?
            xml.EventNotificationAlert.channelName[0] : null;

        // Strip colons from ID to be consistent with net-tools
        const device = String(macAddress).replace(/:/g, '');
        const stateId = device +
            (channelName != null ? '.' + channelName : '') +
            ('.' + eventType);

        // Cancel any existing timer for this state
        if (stateId in this.timers) {
            if (this.timers[stateId]) {
                this.clearTimeout(this.timers[stateId]);
                this.timers[stateId] = null;
            }
        } else {
            // Create device/channels/state if not there...
            // ... which will only be attempted if not in timers as if this ID is in the
            // timers object we must have already seen it and created the state.

            this.log.debug('Creating device ' + device);
            const native = {
                mac: macAddress
            };
            // Add optional parts
            if (xml.EventNotificationAlert?.ipAddress) {
                native.ipAddress = xml.EventNotificationAlert.ipAddress[0];
            }
            await this.setObjectNotExistsAsync(device, {
                type: 'device',
                common: {
                    name: await this.getDeviceName(device)
                },
                native: native
            });

            if (channelName != null) {
                this.log.debug('Creating channel ' + channelName);
                await this.createChannelAsync(device, channelName);
            }

            this.log.debug('Creating state ' + stateId);
            await this.setObjectNotExistsAsync(stateId, {
                type: 'state',
                common: {
                    name: eventType,
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        // Set it true (event in progress)
        this.log.debug('Triggering ' + stateId);
        await this.setStateChangedAsync(stateId, true, true);

        // ... and restart to clear (set false) after 5s
        this.timers[stateId] = this.setTimeout(() => {
            this.setState(stateId, false, true);
            this.timers[stateId] = null;
        }, this.config.alarmTimeout);

        return true; // Success
    }

    async getDeviceName(device) {
        // Output is same as input by default
        let output = device;

        const devices = await this.getForeignObjectsAsync('net-tools.*.' + device, 'device');
        if (Object.keys(devices).length == 1) {
            // As expected, return the device name...
            const device = devices[Object.keys(devices)[0]];
            if (device && device.common && device.common.name) {
                // ... which should always be here.
                output = device.common.name;
            }
        }
        return output;
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new HikvisionAlarmserver(options);
} else {
    // otherwise start the instance directly
    new HikvisionAlarmserver();
}
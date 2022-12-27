'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const http = require('http');

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
                        const xmlObj = await that.decodePayload(request, body);

                        if (xmlObj) {
                            that.logEvent(xmlObj);
                        }
                    });
                } else {
                    that.log.warn('Received non-POST request - ignoring');
                }
                response.end();
            });

            this.server.on('error', function (err) {
                that.log.error('HTTP server error: ' + err);
                that.terminate();
            });

            this.log.info('Server starting to listen on port ' + this.config.port);
            this.server.listen(this.config.port);
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

    async decodePayload(request, body) {
        this.log.debug(body);

        let xmlObj = null;

        if (!('content-type' in request.headers)) {
            this.log.error('No content-type in header!');
        } else {
            let xmlString = null;
            const contentTypeParts = request.headers['content-type'].split(';');

            if (contentTypeParts[0] == 'application/xml') {
                // Payload was pure XML
                xmlString = body;
            } else if (contentTypeParts[0] == 'multipart/form-data') {
                const boundaryRe = new RegExp(' boundary=(.*)');
                const boundaryMatches = request.headers['content-type'].match(boundaryRe);
                if (boundaryMatches && boundaryMatches.length) {
                    const boundary = boundaryMatches[1];

                    // Couldn't get parse-multipart-data to work. Possible TODO: use that.
                    // In the mean time, just pull out with a regexp
                    const xmlRe = new RegExp(`--${boundary}.*Content-Length:\\s*\\d{1,}\\s*(<.*)--${boundary}--`, 's');
                    const xmlMatches = body.match(xmlRe);
                    if (xmlMatches && xmlMatches.length) {
                        xmlString = xmlMatches[1];
                    } else {
                        this.log.error('Failed to extract XML from multipart payload (' + boundary + '): ' + body);
                    }
                } else {
                    this.log.error('No boundary found in multipart header: ' + request.headers['content-type']);
                }
            } else {
                this.log.error('Unhandled content-type: ' + request.headers['content-type']);
            }

            if (xmlString) {
                try {
                    xmlObj = await parseStringPromise(xmlString);
                    if (!xmlObj) {
                        this.log.error('Parse returned null XML');
                    }
                } catch (err) {
                    this.log.error('Error parsing body: ' + err);
                }
            } else {
                this.log.error('Could not find XML message in payload');
            }
        }

        return xmlObj;
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
            return;
        }

        // Channel name is optional
        const channelName = this.config.useChannels && xml.EventNotificationAlert.hasOwnProperty('channelName') ?
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
            if (xml.EventNotificationAlert.hasOwnProperty('ipAddress')) {
                native.ipAddress = xml.EventNotificationAlert.ipAddress[0];
            }
            if (xml.EventNotificationAlert.hasOwnProperty('serialNumber')) {
                native.serialNumber = xml.EventNotificationAlert.serialNumber[0];
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
        await this.setStateChangedAsync(stateId, true, true);

        // ... and restart to clear (set false) after 5s
        this.timers[stateId] = this.setTimeout(() => {
            this.setState(stateId, false, true);
            this.timers[stateId] = null;
        }, 5000 /* TODO: make timeout option? */);
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
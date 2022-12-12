'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const http = require('http');
const multipart = require('parse-multipart-data');

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

                    const chunks = [];
                    request.on('data', function (data) {
                        chunks.push(data);
                    });
                    request.on('end', async function () {
                        const xmlObj = await that.decodePayload(request, chunks);

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

    async decodePayload(request, chunks) {
        const body = chunks.concat();
        this.log.debug(body.toString());

        let xmlObj = null;

        if (!('content-type' in request.headers)) {
            this.log.error('No content-type in header!');
        } else {
            let xmlString = null;
            const contentTypeParts = request.headers['content-type'].split(';');

            if (contentTypeParts[0] == 'application/xml') {
                // Payload was pure XML
                xmlString = body.toString();
            } else if (contentTypeParts[0] == 'multipart/form-data') {
                const boundaryRe = new RegExp(' boundary=(.*)');
                let boundary = request.headers['content-type'].match(boundaryRe);
                if (boundary && boundary.length) {
                    boundary = boundary[1];
                    this.log.debug('boundary: ' + boundary);

                    const bodyParts = multipart.parse(body.toString(), boundary);
                    this.log.debug(JSON.stringify(bodyParts));
                    xmlString = bodyParts[0];
                } else {
                    this.log.error('No boundary found in multipart header: ' + request.headers['content-type']);
                }
            } else {
                this.log.error('Unhandled content-type: ' + request.headers['content-type']);
            }

            if (xmlString) {
                try {
                    xmlObj = await parseStringPromise(xmlString);
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
        let deviceId = null;
        let eventType = null;
        try {
            /* This is inside a try...catch so we handle case when XML was bad */
            /* TODO: make object names configurable? Mac? IP? etc. */
            deviceId = xml.EventNotificationAlert.macAddress;
            eventType = xml.EventNotificationAlert.eventType;
        } catch (err) {
            this.log.error('Bad request - failed to find required XML attributes');
            return;
        }
        // Strip colons from ID to be consistent with net-tools
        const id = String(deviceId).replace(/:/g, '') + '.' + eventType;

        // Cancel any existing timer for this state
        if (id in this.timers) {
            if (this.timers[id]) {
                this.clearTimeout(this.timers[id]);
                this.timers[id] = null;
            }
        } else {
            // Create state if not there...
            // ... which will only be attempted if not in timers as if this ID is in the
            // timers object we must have already seen it and created the state.
            this.log.debug('Creating state ' + id);
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: {
                    name: eventType,
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: true,
                },
                native: {},
            });
        }

        // Set it true (event in progress)
        await this.setStateChangedAsync(id, true, true);

        // ... and restart to clear (set false) after 5s
        this.timers[id] = this.setTimeout(() => {
            this.setState(id, false, true);
            this.timers[id] = null;
        }, 5000 /* TODO: make timeout option? */);
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
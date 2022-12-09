'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const http = require('http');
const parseString = require('xml2js').parseString;

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
                    let body = '';
                    request.on('data', function (data) {
                        body += data;
                    });
                    request.on('end', function () {
                        that.log.debug(body);
                        parseString(body, function (err, xml) {
                            if (err) {
                                that.log.error('Error parsing body: ' + err);
                            } else {
                                that.logEvent(xml);
                            }
                        });

                    });
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
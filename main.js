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
                            that.logEvent(xml.EventNotificationAlert);
                        }
                    });

                });
            }
            response.end();
        });

        this.server.listen(this.config.port);
        this.log.info('Server listening on port ' + this.config.port);
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

    async logEvent(event) {
        /* TODO: make object names configurable? Mac? IP? etc. */
        const deviceId = event.macAddress;
        const eventType = event.eventType;
        const id = deviceId + '.' + eventType;

        // Cancel any existing timer for this state
        if (id in this.timers && this.timers[id]) {
            this.clearTimeout(this.timers[id]);
            this.timers[id] = null;
        }

        // Create state if not there
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

        // Set it true (event in progress)
        await this.setStateAsync(id, true, true);

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
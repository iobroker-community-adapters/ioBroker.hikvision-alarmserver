'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

const fs = require('fs-extra');
const path = require('node:path');
const multipart = require('parse-multipart-data');

const canvas = require('canvas');

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const http = require('http');

const bodyMaxLogLength = 256;

// Duration after which we remove client from list of connections.
// This is long because sometimes a camera can go for hours without issuing event.
const activeConnectionTimeout = 60 * 60 * 24 * 1000;

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

        this.stateTimers = [];
        this.throttleTimers = [];
        this.clientTimers = [];
        this.deviceNameCache = [];
        this.server = null;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.dataDir = utils.getAbsoluteInstanceDataDir(this);
        this.log.debug(JSON.stringify(this.config));

        // Create send config, catching any errors (could be caused by Function)
        try {
            this.sendXmlConfig = {
                type: 'xml',
                instance: this.config.sendXmlInstance,
                command: this.config.sendXmlCommand,
                messageFn: new Function('imageBuffer', 'ctx', `return ${this.config.sendXmlMessage};`),
                throttle: this.config.sendXmlThrottle,
                throttleByDevice: this.config.sendXmlThrottleByDevice
            }
        } catch (err) {
            this.log.error('Failed to create sendXmlConfig - Send to message for XML is likely malformed: ' + err);
        }
        try {
            this.sendImageConfig = {
                type: 'image',
                instance: this.config.sendImageInstance,
                command: this.config.sendImageCommand,
                messageFn: new Function('imageBuffer', 'ctx', `return ${this.config.sendImageMessage};`),
                throttle: this.config.sendImageThrottle,
                throttleByDevice: this.config.sendImageThrottleByDevice
            }
        } catch (err) {
            this.log.error('Failed to create sendImageConfig - Send to message for images is likely malformed: ' + err);          
        }

        const that = this;
        try {
            this.server = http.createServer(function (request, response) {
                if (request.method == 'POST') {
                    that.log.debug(`Request ${request.url} headers: ${JSON.stringify(request.headers)}`);

                    const chunks = [];
                    request.on('data', function (data) {
                        chunks.push(data);
                    });
                    request.on('end', async function () {
                        const body = Buffer.concat(chunks);
                        that.log.debug(`Handling request of ${body.length} bytes`);
                        if (that.log.level == 'silly') {
                            // Dump requests for debugging
                            that.dumpFile({ periodPath: '' }, body, 'lastRequest.txt');
                        }

                        that.handlePayload(request.headers, body);
                        response.statusCode == 200; // Always return success
                        response.end();
                    });
                } else {
                    // Error
                    that.log.warn(`Received non-POST request ${request.url}`);
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
     * Is called when adapter shuts down
     */
    async onUnload() {
        try {
            if (this.server) {
                this.server.close();
                this.log.info('Closed server');
            }
            // Set all states awaiting clear to false immediately
            for (const id in this.stateTimers) {
                this.log.debug(`Clearing state ${id}`);
                this.clearTimeout(this.stateTimers[id]);
                delete this.stateTimers[id];
                await this.setStateAsync(id, false, true);
            }
            // Clear any other timers
            for (const id in this.throttleTimers) {
                this.log.debug(`Clearing throttle timer ${id}`);
                this.clearTimeout(this.throttleTimers[id]);
                delete this.throttleTimers[id];
            }
            for (const device in this.clientTimers) {
                this.log.debug(`Clearing connection timer ${device}`);
                this.clearTimeout(this.clientTimers[device]);
                delete this.clientTimers[device];
            }
            await this.updateConnected();
            this.log.debug('Unload done');
        } catch (err) {
            this.log.error(err);
        }
    }

    async dumpFile(ctx, data, name) {
        const fileName = path.join(this.dataDir, ctx.periodPath, name);
        this.log.debug(`Dumping ${data.length} bytes to ${fileName}`);
        try {
            await fs.outputFile(fileName, data, 'binary');
            // Stash filename in ctx so it can possibly be used later (in sendTo?)
            if (!Array.isArray(ctx.files)) {
                ctx.files = [];
            }
            ctx.files.push(fileName);
        } catch (err) {
            this.log.error(err);
        }
    }

    isXmlPart(part) {
        // TODO: See if parse-multipart-data can be made to pull out XML type
        // but until then, assume XML if no type and no filename.
        return (part['type'] == 'application/xml' ||
            (!('filename' in part) && !('type' in part)));
    }

    isJpegPart(part) {
        return (part.type == 'image/jpeg');
    }

    async handlePayload(headers, body) {
        if (this.log.level == 'silly') {
            if (body.length < bodyMaxLogLength) {
                this.log.debug(body);
            } else {
                this.log.debug(`Body length of ${body.length} is too large to log, first ${bodyMaxLogLength} bytes follow:\n` +
                    body.toString().substring(0, bodyMaxLogLength));
            }
        }

        const contentTypeHeader = 'content-type';
        if (!(contentTypeHeader in headers)) {
            this.log.error('No content type in header!');
        } else {
            // Context for this event
            const ctx = {};

            const contentType = headers[contentTypeHeader].toString().split(';')[0];
            switch (contentType) {
                case 'application/xml':
                    // Payload was pure XML
                    await this.handleXml(ctx, body);
                    break;

                case 'multipart/form-data':
                    const boundary = multipart.getBoundary(headers[contentTypeHeader]);
                    const parts = multipart.parse(body, boundary);
                    this.log.debug(`Found ${parts.length} parts`);

                    // Find XML first so we can pull out other details later
                    for (const part of parts) {
                        this.log.debug('Part keys: ' + JSON.stringify(Object.keys(part)));
                        if (this.isXmlPart(part)) {
                            this.log.debug('This part is XML: ' + part.data);
                            if (ctx.xml) {
                                this.log.warn('Payload seem to have more than one XML part!');
                            } else {
                                await this.handleXml(ctx, part.data);
                            }
                        }
                    }

                    // Only carry on if we've successfully logged the event above
                    if (!ctx.eventLogged) {
                        this.log.warn('Event logging failed - skipping other parts');
                    } else {
                        if (!this.config.saveImages && this.sendImageConfig?.instance) {
                            this.log.debug('Skipping any image(s) as no save/send enabled');
                        } else {
                            // Now handle image parts
                            for (const part of parts) {
                                if (this.isJpegPart(part)) {
                                    await this.handleJpegPart(ctx, part);
                                }
                            }
                        }
                    }
                    this.log.debug('Finished multipart: ' + JSON.stringify(ctx));
                    break;

                default:
                    this.log.error('Unhandled content type: ' + contentType);
                    break;
            }
        }
    }

    async handleJpegPart(ctx, part) {
        // Add .jpg to filename if not there
        let fileParts = path.parse(part.filename);
        if (fileParts.ext == '') {
            fileParts.ext = '.jpg';
        } else if (fileParts.ext != '.jpg' && fileParts.ext != '.jpeg') {
            fileParts.ext += '.jpg';
        }
        // Prefix filename
        fileParts.name = ctx.fileBase + '-' + fileParts.name;
        fileParts.base = fileParts.name + fileParts.ext;
        const fileName = path.format(fileParts);

        // Default buffer is one passed in
        let imageBuffer = part.data;

        if (this.config.annotateImages) {
            // See if there are any co-ordinates for target
            let targetRect;
            try {
                const xmlTargetRect = ctx.xml.EventNotificationAlert.DetectionRegionList[0].DetectionRegionEntry[0].TargetRect[0];
                targetRect = [
                    // Sometimes ints but sometimes floats, so parse the latter (see below).
                    parseFloat(xmlTargetRect.X[0]),
                    parseFloat(xmlTargetRect.Y[0]),
                    parseFloat(xmlTargetRect.width[0]),
                    parseFloat(xmlTargetRect.height[0])
                ];
            } catch (err) {
                this.log.warn('Could not find target x/y/width/height');
            }

            if (targetRect) {
                const imgIn = await canvas.loadImage(imageBuffer);

                let xScale = imgIn.width;
                let yScale = imgIn.height;
                // XML TargetRect co-ordinates seem to be sometimes be 0-1000 but sometimes 0-1 (float).
                // If everything is <= 1 assume 0-1 (float) which means scales will already be good.
                // If not, divide scales by 1000;
                if (targetRect[0] > 1 || targetRect[1] > 1 || targetRect[2] > 1 || targetRect[3] > 1) {
                    xScale /= 1000;
                    yScale /= 1000;
                }
                targetRect[0] *= xScale;
                targetRect[1] *= yScale;
                targetRect[2] *= xScale;
                targetRect[3] *= yScale;

                // Draw target rectangle on image
                this.log.debug(`Drawing targetRect: ${targetRect} (${ctx.detectionTarget})`);

                // TODO: maybe someday config
                const labelLineStyle = 'orange';
                const labelTextStyle = 'black';
                const labelPadding = 4;
                const lableTextRatio = 48;

                const imgOut = canvas.createCanvas(imgIn.width, imgIn.height);
                const context2d = imgOut.getContext('2d')
                context2d.drawImage(imgIn, 0, 0);
                context2d.strokeStyle = labelLineStyle;
                context2d.lineWidth = labelPadding * 2;
                context2d.strokeRect(...targetRect);
                if (ctx.detectionTarget) {
                    // Label rectangle
                    context2d.font = Math.round(imgIn.width / lableTextRatio) + 'px sans-serif';
                    const metrics = context2d.measureText(ctx.detectionTarget);
                    this.log.debug(JSON.stringify(metrics));
                    const labelWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight + labelPadding * 2;
                    const labelHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + labelPadding * 2;
                    let labelX = targetRect[0] - labelPadding;
                    if (labelX + labelWidth > imgIn.width) {
                        // Shift label left so it fits in image
                        labelX = imgIn.width - labelWidth;
                    }
                    let labelY = targetRect[1] - labelHeight;
                    if (labelY < 0) {
                        // Draw label under box rather than above
                        labelY = targetRect[1] + targetRect[3];
                    }
                    context2d.fillStyle = labelLineStyle;
                    context2d.fillRect(labelX, labelY, labelWidth, labelHeight);

                    context2d.fillStyle = labelTextStyle;
                    context2d.fillText(ctx.detectionTarget, labelX + labelPadding, labelY + metrics.actualBoundingBoxAscent + labelPadding);
                }
                imageBuffer = imgOut.toBuffer('image/jpeg');
            }
        }

        if (this.config.saveImages) {
            await this.dumpFile(ctx, imageBuffer, fileName);
        }

        await this.checkAndSendTo(this.sendImageConfig, ctx, imageBuffer);
    }

    async checkAndSendTo(sendTarget, ctx, imageBuffer) {
        if (sendTarget?.instance && this.sendToPassThrottle(sendTarget, ctx)) {
            const sendToArgs = [sendTarget.instance];
            if (sendTarget.command) {
                sendToArgs.push(sendTarget.command);
            }
            this.log.debug('sendTo: ' + sendToArgs);

            try {
                // sendToMessage config is a code snipped string that evaluates to the message to send.
                // Available variables passed into this code snippet string are simply 'imageBuffer'.
                // TODO: Add more items from ctx.
                sendToArgs.push(sendTarget.messageFn(imageBuffer, ctx));
                this.log.debug(JSON.stringify(sendToArgs).substring(0, 1024));
                await this.sendToAsync(...sendToArgs);
            } catch (err) {
                this.log.error('Failed in sendTo: ' + err);
            }
        }
    }

    sendToPassThrottle(sendTarget, ctx) {
        // Let this pass by default
        let pass = true;
        if (!sendTarget.throttle) {
            this.log.debug(`No throttle for ${sendTarget.type}`);
        } else {
            let timerId = sendTarget.type;
            if (sendTarget.throttleByDevice) {
                timerId += ctx.device;
            }
            if (this.throttleTimers[timerId]) {
                this.log.debug('Timer seems to be running, throttling message: ' + timerId);
                pass = false;
            } else {
                this.log.debug('Setting message throttle timer: ' + timerId);
                this.throttleTimers[timerId] = this.setTimeout(
                    (timedOutId) => {
                        this.log.debug('Throttle timer is done: ' + timedOutId);
                        delete this.throttleTimers[timedOutId];
                    },
                    sendTarget.throttle, timerId
                );
            }
        }
        return pass;
    }

    async handleXml(ctx, xmlBuffer) {
        try {
            ctx.xml = await parseStringPromise(new String(xmlBuffer));
        } catch (err) {
            this.log.error('Error parsing XML: ' + err);
        }
        if (!ctx.xml) {
            this.log.error('Parse returned null XML');
        } else {
            await this.logXmlEvent(ctx);
            if (ctx.eventLogged && this.config.saveXml) {
                await this.dumpFile(ctx, xmlBuffer, ctx.fileBase + '.xml');
            }
        }
    }

    async logXmlEvent(ctx) {
        try {
            // This is inside a try...catch so we handle case when XML was bad.
            // TODO: make object names configurable? Mac? IP? etc.
            ctx.macAddress = ctx.xml.EventNotificationAlert.macAddress[0];
            ctx.eventType = ctx.xml.EventNotificationAlert.eventType[0];
        } catch (err) {
            this.log.error('Bad request - failed to find required XML attributes');
            // We cannot carry on...
            return;
        }
        // detection Target is optional
        try {
            ctx.detectionTarget = ctx.xml.EventNotificationAlert.DetectionRegionList[0].DetectionRegionEntry[0].detectionTarget[0];
        } catch (err) {
            this.log.debug('No detectionTarget found');
        }
        // Channel name is optional
        try {
            ctx.channelName = ctx.xml.EventNotificationAlert.channelName[0];
        } catch (err) {
            this.log.debug('No channelName found');
        }
        // Use XML timestamp if we can
        try {
            ctx.ts = new Date(Date.parse(ctx.xml.EventNotificationAlert.dateTime[0]));
        } catch (err) {
            this.log.debug('No dateTime found - using new Date()');
            ctx.ts = new Date();
        }
        // Add device & event type to base
        ctx.periodPath =
            ctx.ts.getFullYear().toString() +
            (ctx.ts.getMonth() + 1).toString().padStart(2, '0') +
            ctx.ts.getDate().toString().padStart(2, '0');

        ctx.fileBase =
            ctx.ts.getHours().toString().padStart(2, '0') +
            ctx.ts.getMinutes().toString().padStart(2, '0') +
            ctx.ts.getSeconds().toString().padStart(2, '0') +
            ctx.ts.getMilliseconds().toString().padStart(3, '0');

        // Channel for state
        let channelName;
        if (this.config.useDetectionTargets && ctx.detectionTarget) {
            if (this.config.useChannels && ctx.channelName) {
                channelName = ctx.channelName + '.' + ctx.detectionTarget;
            } else {
                channelName = ctx.detectionTarget;
            }
        } else if (this.config.useChannels && ctx.channelName) {
            channelName = ctx.channelName;
        }

        // Strip colons from ID to be consistent with net-tools
        ctx.device = String(ctx.macAddress).replace(/:/g, '');
        ctx.deviceName = await this.getDeviceName(ctx.device);
        ctx.stateId = ctx.device +
            (channelName ? '.' + channelName : '') +
            ('.' + ctx.eventType);

        // Cancel any existing timer for this state
        if (ctx.stateId in this.stateTimers) {
            if (this.stateTimers[ctx.stateId]) {
                this.clearTimeout(this.stateTimers[ctx.stateId]);
                delete this.stateTimers[ctx.stateId];
            }
        } else {
            // Create device/channels/state if not there...
            // ... which will only be attempted if not in timers as if this ID is in the
            // timers object we must have already seen it and created the state.

            this.log.debug('Creating device ' + ctx.device);
            const native = {
                mac: ctx.macAddress
            };
            // Add optional parts
            if (ctx.xml.EventNotificationAlert?.ipAddress) {
                native.ipAddress = ctx.xml.EventNotificationAlert.ipAddress[0];
            }
            await this.setObjectNotExistsAsync(ctx.device, {
                type: 'device',
                common: {
                    name: ctx.deviceName
                },
                native: native
            });

            if (channelName != null) {
                this.log.debug('Creating channel ' + channelName);
                await this.createChannelAsync(ctx.device, channelName);
            }

            this.log.debug('Creating state ' + ctx.stateId);
            await this.setObjectNotExistsAsync(ctx.stateId, {
                type: 'state',
                common: {
                    name: ctx.eventType,
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        ctx.fileBase += `-${ctx.device}-${ctx.eventType}`;

        // Set it true (event in progress)...
        this.log.debug('Triggering ' + ctx.stateId);
        await this.setStateChangedAsync(ctx.stateId, true, true);

        // ... and restart to clear (set false)
        this.stateTimers[ctx.stateId] = this.setTimeout((stateId) => {
            this.setState(stateId, false, true);
            delete this.stateTimers[stateId];
        }, this.config.alarmTimeout, ctx.stateId);

        // Set eventLogged so upon return any other parts are processed too
        ctx.eventLogged = true;

        await this.checkAndSendTo(this.sendXmlConfig, ctx);

        // Successfully logged event so add this device to list of connected clients
        this.clientConnected(ctx.device);
    }

    async getDeviceName(device) {
        // Populate cache if not already there
        if (!this.deviceNameCache[device]) {
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
            this.deviceNameCache[device] = output;
        }
        return this.deviceNameCache[device];
    }

    async updateConnected() {
        const deviceList = Object.keys(this.clientTimers);
        // Nicer to show client names if we can find them
        for (let lp = 0; lp < deviceList.length; lp++) {
            deviceList[lp] = await this.getDeviceName(deviceList[lp]);
        }
        await this.setStateAsync(
            'info.connection',
            deviceList.length ? deviceList.join(',') : '',
            true
        );
    }

    clentDisconnected(device) {
        delete this.clientTimers[device];
        this.updateConnected();
    }

    clientConnected(device) {
        let updateList = false;
        if (this.clientTimers[device]) {
            // Timer already running, clear it (will be restarted below).
            this.clearTimeout(this.clientTimers[device]);
            this.log.debug(`Existing client connection: ${device}`);
        } else {
            // New client - list will need updating.
            updateList = true;
            this.log.debug(`New client connection: ${device}`);
        }
        this.clientTimers[device] = this.setTimeout(this.clentDisconnected, activeConnectionTimeout, device);

        if (updateList) {
            this.updateConnected();
        }
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
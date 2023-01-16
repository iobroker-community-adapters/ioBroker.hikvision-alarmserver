'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.2
 */

const fs = require('fs-extra');
const path = require('node:path');
const multipart = require('parse-multipart-data');

const Canvas = require('canvas');

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
        this.dataDir = '/tmp/hv';
        this.log.debug('dataDir: ' + this.dataDir);

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
                        if (that.log.level == 'silly') {
                            // Dump requests for debugging
                            that.log.debug(`Handling request of ${body.length} bytes`);
                            that.dumpFile(ctx, body, 'lastRequest.txt');
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

    async dumpFile(ctx, data, name) {
        const fileName = path.join(this.dataDir, ctx.periodPath, name);
        this.log.debug(`Dumping ${data.length} bytes to ${fileName}`);
        try {
            await fs.outputFile(fileName, data, 'binary');
        } catch (err) {
            this.log.error(err);
            return false; // Error
        }
        return true; // Success
    }

    isXmlPart(part) {
        // TODO: See if parse-multipart-data can be made to pull out XML type
        // but until then, assume XML if no type and no filename.
        return (part['type'] == 'application/xml' ||
            (!('filename' in part) && !('type' in part)));
    }

    isImagePart(part) {
        return (part.type == 'image/jpeg');
    }

    async handlePayload(headers, body) {
        // Assume failure
        let success = false;

        // Context for this event
        const ctx = {
            ts: new Date()
        }
        ctx.periodPath = ctx.ts.toISOString().substring(0, 10);

        if (body.length < bodyMaxLogLength) {
            this.log.debug(body);
        } else {
            this.log.debug(`Body length of ${body.length} is too large to log, first ${bodyMaxLogLength} bytes follow:\n` +
                body.toString().substring(0, bodyMaxLogLength));
        }

        if (!('content-type' in headers)) {
            this.log.error('No content-type in header!');
        } else {
            const contentType = headers['content-type'].toString().split(';')[0];
            switch (contentType) {
                case 'application/xml':
                    // Payload was pure XML
                    ctx.xml = await this.decodeXml(body);
                    await this.logEvent(ctx);
                    break;

                case 'multipart/form-data':
                    const boundary = multipart.getBoundary(headers['content-type']);
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
                                ctx.xml = await this.decodeXml(part.data);
                                await this.logEvent(ctx);
                                if (this.config.saveXml) {
                                    this.dumpFile(ctx, part.data, ctx.fileBase + '.xml');
                                }
                            }
                        }
                    }

                    // Only carry on if we've found the XML part of this message
                    if (!ctx.xml) {
                        this.log.warn('No XML found in multipart payload');
                    } else {
                        if (!this.config.saveImages) {
                            this.log.debug('Skipping image(s)');
                        } else {
                            // Now handle image parts
                            for (const part of parts) {
                                if (this.isImagePart(part)) {
                                    this.handleImagePart(ctx, part);
                                }
                            }
                        }
                    }

                    break;

                default:
                    this.log.error('Unhandled content-type: ' + contentType);
                    break;
            }
        }
    }

    async handleImagePart(ctx, part) {
        this.log.debug(JSON.stringify(part).substring(0, 1024));

        // Handle content types we know
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

        // See if there are any co-ordinates for target
        let targetRect = null;
        try {
            const x = parseInt(ctx.xml.EventNotificationAlert.DetectionRegionList[0].DetectionRegionEntry[0].TargetRect[0].X[0]);
            const y = parseInt(ctx.xml.EventNotificationAlert.DetectionRegionList[0].DetectionRegionEntry[0].TargetRect[0].Y[0]);
            const width = parseInt(ctx.xml.EventNotificationAlert.DetectionRegionList[0].DetectionRegionEntry[0].TargetRect[0].width[0]);
            const height = parseInt(ctx.xml.EventNotificationAlert.DetectionRegionList[0].DetectionRegionEntry[0].TargetRect[0].height[0]);
            targetRect = [x, y, width, height];

            this.log.debug(`TargetRect: ${targetRect}`);
        } catch (err) {
            this.log.warn('Could not find target x/y/width/height');
        }
        let detectionTarget = null;
        try {
            detectionTarget = ctx.xml.EventNotificationAlert.DetectionRegionList[0].DetectionRegionEntry[0].detectionTarget[0];
            this.log.debug(`detectionTarget: ${detectionTarget}`);
        } catch (err) {
            this.log.warn('Could not find detectionTarget');
        }

        if (targetRect != null) {
            this.log.debug('Drawing targetRect: ' + targetRect);
            // Draw target rectangle on image
            const img = await Canvas.loadImage(part.data);
            const canvas = Canvas.createCanvas(img.width, img.height);
            const cctx2d = canvas.getContext('2d')
            cctx2d.drawImage(img, 0, 0);
            cctx2d.strokeStyle = 'blue';
            cctx2d.lineWidth = 4;
            cctx2d.strokeRect(...targetRect);
            if (detectionTarget != null) {
                // Label rectangle
                cctx2d.font = '24px sans-serif';
                let metrics = cctx2d.measureText(detectionTarget);
                this.log.debug(JSON.stringify(metrics));
                cctx2d.fillStyle = 'blue'
                cctx2d.fillRect(targetRect[0], targetRect[1],
                    metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight + 2,
                    metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + 2);

                cctx2d.fillStyle = 'black';
                cctx2d.fillText(detectionTarget, targetRect[0], targetRect[1] + metrics.actualBoundingBoxAscent);
            }
            this.dumpFile(ctx, canvas.toBuffer('image/jpeg'), fileName);
        } else {
            this.log.debug('Dumping original image');
            this.dumpFile(ctx, part.data, fileName);
        }
    }

    async decodeXml(xmlBuffer) {
        let xmlObj = null;
        try {
            xmlObj = await parseStringPromise(new String(xmlBuffer));
            if (!xmlObj) {
                this.log.error('Parse returned null XML');
            }
        } catch (err) {
            this.log.error('Error parsing XML: ' + err);
        }
        return xmlObj;
    }

    async logEvent(ctx) {
        let macAddress = null;
        let eventType = null;

        try {
            // This is inside a try...catch so we handle case when XML was bad.
            // TODO: make object names configurable? Mac? IP? etc.
            macAddress = ctx.xml.EventNotificationAlert.macAddress[0];
            eventType = ctx.xml.EventNotificationAlert.eventType[0];
        } catch (err) {
            this.log.error('Bad request - failed to find required XML attributes');
        }

        // Channel name is optional
        const channelName = this.config.useChannels && ctx.xml.EventNotificationAlert?.channelName ?
            ctx.xml.EventNotificationAlert.channelName[0] : null;

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
            if (ctx.xml.EventNotificationAlert?.ipAddress) {
                native.ipAddress = ctx.xml.EventNotificationAlert.ipAddress[0];
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

        // Stash derived data
        ctx.fileBase = `${ctx.ts.getTime().toString(16)}-${device}-${eventType}`;

        // Set it true (event in progress)
        this.log.debug('Triggering ' + stateId);
        await this.setStateChangedAsync(stateId, true, true);

        // ... and restart to clear (set false)
        this.timers[stateId] = this.setTimeout(() => {
            this.setState(stateId, false, true);
            this.timers[stateId] = null;
        }, this.config.alarmTimeout);
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
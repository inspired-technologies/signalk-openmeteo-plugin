/*
    Copyright © 2026 Inspired Technologies GmbH (www.inspiredtechnologies.eu)

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
*/

'use strict'
const log = require('debug')('openmeteo-signalk')
const { OpenMeteo, MODELS, GROUPS, DEFAULTS, LIMITS } = require('./openmeteo')

const PLUGIN_ID = 'openmeteo-signalk'

module.exports = function (app) {
    const plugin = {
        id: PLUGIN_ID,
        name: 'Open-Meteo Forecast',
        description: 'Provide current conditions and forecast data from the Open-Meteo weather service',
    }

    let forecast = null
    let unsubscribes = []

    plugin.start = function (options) {
        log('Plugin starting ...')
        forecast = new OpenMeteo({
            id: PLUGIN_ID,
            emit: delta => app.handleMessage(PLUGIN_ID, delta),
            status: msg => app.setPluginStatus(msg),
            error: msg => app.setPluginError(msg),
            getSelfPath: path => app.getSelfPath(path),
        })

        app.subscriptionmanager.subscribe(
            { context: 'vessels.self', subscribe: forecast.subscriptions },
            unsubscribes,
            subscriptionError => app.error('Error: ' + subscriptionError),
            delta => forecast.onDelta(delta)
        )

        forecast.start(options || {})
        log('Plugin started.')
    }

    plugin.stop = function () {
        log('Plugin stopping ...')
        unsubscribes.forEach(f => f())
        unsubscribes = []
        if (forecast) forecast.stop()
        forecast = null
        log('Plugin stopped.')
    }

    plugin.schema = {
        type: 'object',
        title: 'Open-Meteo Forecast Configuration',
        description: 'Weather forecast for the vessel position - powered by Open-Meteo.com (CC BY 4.0)',
        required: ['model', 'offset'],
        properties: {
            model: {
                type: 'string',
                title: 'Weather model',
                description: 'Forecast model providing the data - published as $source ' + PLUGIN_ID + '.<model>',
                enum: MODELS.map(m => m.id),
                enumNames: MODELS.map(m => m.title),
                default: DEFAULTS.model,
            },
            model2: {
                type: 'string',
                title: 'Second weather model (optional)',
                description: 'Published in parallel on the same paths as $source ' + PLUGIN_ID + '.<model> - only values the model provides',
                enum: ['', ...MODELS.map(m => m.id)],
                enumNames: ['- none -', ...MODELS.map(m => m.title)],
                default: DEFAULTS.model2,
            },
            offset: {
                type: 'number',
                title: 'Forecast offset',
                description: `Publish the forecast for the full hour <offset> hours ahead (${LIMITS.offset.min}-${LIMITS.offset.max})`,
                minimum: LIMITS.offset.min,
                maximum: LIMITS.offset.max,
                default: DEFAULTS.offset,
            },
            horizon: {
                type: 'number',
                title: 'Forecast horizon',
                description: `Hours ahead used for minimum / maximum / accumulated values (${LIMITS.horizon.min}-${LIMITS.horizon.max})`,
                minimum: LIMITS.horizon.min,
                maximum: LIMITS.horizon.max,
                default: DEFAULTS.horizon,
            },
            distance: {
                type: 'number',
                title: 'Refresh distance (nm)',
                description: 'Optional - refresh in between when the vessel moved this distance since the last update; empty: hourly refresh only',
                minimum: LIMITS.distance.min,
                maximum: LIMITS.distance.max,
            },
            today: {
                type: 'boolean',
                title: "Publish today's forecast on 'environment.forecast.today'",
                description: 'minimum / maximum temperature, humidity and pressure, rain, snow, precipitation probability, maximum gusts and weather of the local day',
                default: DEFAULTS.today,
            },
            current: {
                type: 'boolean',
                title: "Publish current conditions on 'environment.outside'",
                description: 'turn this on, only if no other sensors for outside conditions are on the network (eg. BME280, RUUVI)',
                default: DEFAULTS.current,
            },
            variables: {
                type: 'object',
                title: 'Measurements',
                properties: Object.fromEntries(Object.entries(GROUPS).map(([key, g]) => [key,
                    Object.assign({ type: 'boolean', title: g.title, default: g.default }, g.description ? { description: g.description } : {})])),
            },
            cellSelection: {
                type: 'string',
                title: 'Grid cell selection',
                description: "Prefer sea or land grid cells near the position - 'sea' suits vessels, 'land' fixed stations ashore",
                enum: ['sea', 'land', 'nearest'],
                default: DEFAULTS.cellSelection,
            },
            apikey: {
                type: 'string',
                title: 'API key (optional)',
                description: 'Only required for commercial or heavy use - acquire your own key at https://open-meteo.com/en/pricing (none is provided with the plugin)',
            },
        },
    }

    return plugin
}

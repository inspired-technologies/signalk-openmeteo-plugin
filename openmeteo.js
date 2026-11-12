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
const convert = require('./skunits')
const log = require('debug')('openmeteo-signalk')

// ── Open-Meteo endpoints ─────────────────────────────────────────────────────
// Non-commercial use is free and key-less; an apikey switches to the customer servers.
const ENDPOINTS = {
    forecast: { free: 'https://api.open-meteo.com/v1/forecast', commercial: 'https://customer-api.open-meteo.com/v1/forecast' },
    marine: { free: 'https://marine-api.open-meteo.com/v1/marine', commercial: 'https://customer-marine-api.open-meteo.com/v1/marine' },
}

// ── SignalK paths ────────────────────────────────────────────────────────────
const NAV_POSITION = 'navigation.position'
const NAV_ALTITUDE = 'navigation.gnss.antennaAltitude'
const PATH_FORECAST = 'environment.forecast.'
const PATH_TODAY = 'environment.forecast.today.'
const PATH_CURRENT = 'environment.outside.'
const PATH_SUNLIGHT = 'environment.sunlight.times.'
const PATH_FORECAST_TIME = PATH_FORECAST + 'time'

// ── Timing ───────────────────────────────────────────────────────────────────
const ONE_MINUTE = 60 * 1000
const ONE_HOUR = 60 * ONE_MINUTE
const TICK_INTERVAL = ONE_MINUTE            // scheduler resolution
const REFRESH_INTERVAL = ONE_HOUR           // regular refresh - one hour after the last update
const RETRY_MIN = ONE_MINUTE                // back-off after a failed request, doubled per failure ...
const RETRY_MAX = 15 * ONE_MINUTE           // ... up to this limit (long offline periods at sea)
const REQUEST_TIMEOUT = 20 * 1000
const META_TIMEOUT = REFRESH_INTERVAL / 1000  // s - values expire after one refresh cycle

const DEFAULTS = {
    model: 'best_match',
    model2: '',
    offset: 1,
    horizon: 24,
    current: false,
    today: true,
    distance: null,
    cellSelection: 'sea',
}
const LIMITS = { offset: { min: 0, max: 48 }, horizon: { min: 1, max: 96 }, distance: { min: 0.1, max: 100 } }

// Model identifiers verified against the forecast API (HTTP 200).
const MODELS = [
    { id: 'best_match', title: 'Best match - Open-Meteo combines the most suitable models' },
    { id: 'ecmwf_ifs025', title: 'ECMWF IFS 0.25°' },
    { id: 'ecmwf_ifs', title: 'ECMWF IFS HRES 9 km' },
    { id: 'ecmwf_aifs025_single', title: 'ECMWF AIFS 0.25°' },
    { id: 'gfs_seamless', title: 'NOAA GFS Seamless' },
    { id: 'icon_seamless', title: 'DWD ICON Seamless' },
    { id: 'icon_eu', title: 'DWD ICON-EU' },
    { id: 'icon_d2', title: 'DWD ICON-D2' },
    { id: 'meteofrance_seamless', title: 'Météo-France Seamless' },
    { id: 'ukmo_seamless', title: 'UK Met Office Seamless' },
    { id: 'gem_seamless', title: 'Environment Canada GEM Seamless' },
    { id: 'jma_seamless', title: 'JMA Seamless' },
    { id: 'metno_seamless', title: 'MET Norway Nordic Seamless' },
    { id: 'knmi_seamless', title: 'KNMI Seamless' },
    { id: 'dmi_seamless', title: 'DMI Seamless' },
    { id: 'geosphere_seamless', title: 'GeoSphere Austria Seamless' },
    { id: 'cma_grapes_global', title: 'CMA GRAPES Global' },
]

// Measurement groups selectable in the plugin configuration.
const GROUPS = {
    temperature: { title: 'Temperature at 2 m', description: 'incl. apparent temperature, dew point, minimum / maximum over horizon', default: true },
    humidity: { title: 'Relative humidity at 2 m', default: true },
    pressure: { title: 'Atmospheric pressure', description: 'at station elevation (navigation.gnss.antennaAltitude), sea level by default', default: true },
    wind: { title: 'Wind at 10 m', description: 'speed, direction and gusts', default: true },
    precipitation: { title: 'Precipitation', description: 'probability, rain, snow and accumulated over horizon', default: true },
    weather: { title: 'Weather condition', description: 'WMO weather code, description and icon', default: true },
    clouds: { title: 'Cloud cover, visibility and UV index', default: false },
    storm: { title: 'Convective potential energy and lifted index', default: false },
    snow: { title: 'Snow depth', default: false },
    sea: { title: 'Waves, ocean current and water temperature', description: 'additional request to the Open-Meteo Marine API', default: false },
}

// ── WMO weather interpretation codes (as used by Open-Meteo) ────────────────
// main / icon follow the OpenWeather conventions so dashboards built for the
// OpenWeather plugin keep working.
const WMO = {
    0: ['Clear', 'clear sky', '01'],
    1: ['Clear', 'mainly clear', '02'],
    2: ['Clouds', 'partly cloudy', '03'],
    3: ['Clouds', 'overcast', '04'],
    45: ['Fog', 'fog', '50'],
    48: ['Fog', 'depositing rime fog', '50'],
    51: ['Drizzle', 'light drizzle', '09'],
    53: ['Drizzle', 'moderate drizzle', '09'],
    55: ['Drizzle', 'dense drizzle', '09'],
    56: ['Drizzle', 'light freezing drizzle', '09'],
    57: ['Drizzle', 'dense freezing drizzle', '09'],
    61: ['Rain', 'slight rain', '10'],
    63: ['Rain', 'moderate rain', '10'],
    65: ['Rain', 'heavy rain', '10'],
    66: ['Rain', 'light freezing rain', '13'],
    67: ['Rain', 'heavy freezing rain', '13'],
    71: ['Snow', 'slight snow fall', '13'],
    73: ['Snow', 'moderate snow fall', '13'],
    75: ['Snow', 'heavy snow fall', '13'],
    77: ['Snow', 'snow grains', '13'],
    80: ['Rain', 'slight rain showers', '09'],
    81: ['Rain', 'moderate rain showers', '09'],
    82: ['Rain', 'violent rain showers', '09'],
    85: ['Snow', 'slight snow showers', '13'],
    86: ['Snow', 'heavy snow showers', '13'],
    95: ['Thunderstorm', 'thunderstorm', '11'],
    96: ['Thunderstorm', 'thunderstorm with slight hail', '11'],
    99: ['Thunderstorm', 'thunderstorm with heavy hail', '11'],
}

function weatherMain(code) { return WMO[code] ? WMO[code][0] : null }
function weatherDescription(code) { return WMO[code] ? WMO[code][1] : null }
function weatherIcon(code, isDay) { return WMO[code] ? WMO[code][2] + (isDay === 0 ? 'n' : 'd') : null }

// ── Unit handling ────────────────────────────────────────────────────────────
// Open-Meteo unit labels that skunits does not know (yet) under the same name.
const UNIT_ALIASES = { 'unixtime': 'unixdate', 'km/h': 'kmh', 'wmo code': '', 'undefined': '' }

function isMissing(value) {
    return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))
}

// Converts an API value to SignalK units. Missing values stay null - skunits
// would otherwise turn null into 0 (null * 1.0) or 1970-01-01 (unixdate).
function toSK(apiUnit, value) {
    if (isMissing(value)) return null
    const unit = UNIT_ALIASES[apiUnit] !== undefined ? UNIT_ALIASES[apiUnit] : (apiUnit || '')
    return convert.toSignalK(unit, value).value
}

function sum(...values) {
    const present = values.filter(v => !isMissing(v))
    return present.length ? present.reduce((a, b) => a + b, 0) : null
}

// Snowfall is reported in cm of snow; 7 cm snow ≈ 10 mm water equivalent.
function snowWaterEquivalent(value, unit) {
    if (isMissing(value)) return null
    return unit === 'cm' ? value * 10 / 7 : value
}

// ── Measure definitions ──────────────────────────────────────────────────────
// Each definition names the Open-Meteo variables it needs (api) and how to
// derive the SignalK value from a row (value). Without value(), the first api
// variable is converted using the unit reported by the API.
//
// MEASURES apply to the hourly forecast at <offset> and - unless current:false -
// to the current conditions published on environment.outside.*
const MEASURES = [
    { group: 'temperature', path: 'temperature', units: 'K', api: ['temperature_2m'], description: 'Temperature at 2 m above ground' },
    { group: 'temperature', path: 'temperature.feelslike', units: 'K', api: ['apparent_temperature'], description: 'Apparent temperature, accounts for the human perception of weather' },
    { group: 'temperature', path: 'temperature.dewpoint', units: 'K', api: ['dew_point_2m'], description: 'Dew point temperature at 2 m above ground' },
    { group: 'humidity', path: 'relativeHumidity', units: 'ratio', api: ['relative_humidity_2m'], description: 'Relative humidity at 2 m above ground' },
    { group: 'pressure', path: 'pressure', units: 'Pa', api: ['surface_pressure'], description: 'Atmospheric pressure at station elevation (sea level unless navigation.gnss.antennaAltitude is present)' },
    { group: 'wind', path: 'wind.speed', units: 'm/s', api: ['wind_speed_10m'], description: 'Wind speed at 10 m above ground' },
    { group: 'wind', path: 'wind.direction', units: 'rad', api: ['wind_direction_10m'], description: 'Wind direction at 10 m above ground, angle counting clockwise from North (coming from)' },
    { group: 'wind', path: 'wind.gust', units: 'm/s', api: ['wind_gusts_10m'], description: 'Wind gusts at 10 m above ground, maximum of the preceding hour' },
    { group: 'precipitation', path: 'precipitation.probability', units: 'ratio', api: ['precipitation_probability'], current: false, description: 'Probability of precipitation (> 0.1 mm) within the preceding hour' },
    { group: 'precipitation', path: 'precipitation.rain', units: 'mm/h', api: ['rain', 'showers'], description: 'Rain incl. showers, liquid water',
        value: (r, ctx) => perHour(sum(r.raw('rain'), r.raw('showers')), ctx) },
    { group: 'precipitation', path: 'precipitation.snow', units: 'mm/h', api: ['snowfall'], description: 'Snowfall, water equivalent',
        value: (r, ctx) => perHour(snowWaterEquivalent(r.raw('snowfall'), r.unit('snowfall')), ctx) },
    { group: 'clouds', path: 'weather.clouds', units: 'ratio', api: ['cloud_cover'], description: 'Total cloud cover' },
    { group: 'clouds', path: 'weather.visibility', units: 'm', api: ['visibility'], description: 'Visibility' },
    { group: 'clouds', path: 'weather.uvindex', units: '', api: ['uv_index'], description: 'UV index' },
    { group: 'weather', path: 'weather.code', units: '', api: ['weather_code'], description: 'WMO weather interpretation code' },
    { group: 'weather', path: 'weather', units: '', api: ['weather_code'], description: 'Group of weather parameters (Clear, Clouds, Rain, Snow etc.)',
        value: r => weatherMain(r.raw('weather_code')) },
    { group: 'weather', path: 'description', units: '', api: ['weather_code'], description: 'Weather condition within the group',
        value: r => weatherDescription(r.raw('weather_code')) },
    { group: 'weather', path: 'weather.icon', units: '', api: ['weather_code', 'is_day'], description: 'Weather icon id (OpenWeather convention)',
        value: r => weatherIcon(r.raw('weather_code'), r.raw('is_day')) },
    { group: 'storm', path: 'storm.energy', units: 'J/kg', api: ['cape'], current: false, description: 'Convective available potential energy' },
    { group: 'storm', path: 'storm.index', units: 'K', api: ['lifted_index'], current: false, description: 'Lifted index' },
    { group: 'snow', path: 'snow', units: 'm', api: ['snow_depth'], current: false, description: 'Snow depth on the ground' },
]

// Aggregates over the hourly forecast horizon, published on environment.forecast.*
const AGGREGATES = [
    { group: 'temperature', path: 'temperature.minimum', units: 'K', api: ['temperature_2m'], description: 'Minimum temperature over forecast horizon',
        value: r => toSK(r.unit('temperature_2m'), minimum(r.window('temperature_2m'))) },
    { group: 'temperature', path: 'temperature.maximum', units: 'K', api: ['temperature_2m'], description: 'Maximum temperature over forecast horizon',
        value: r => toSK(r.unit('temperature_2m'), maximum(r.window('temperature_2m'))) },
    { group: 'precipitation', path: 'precipitation.accumulated', units: 'mm', api: ['precipitation'], description: 'Accumulated precipitation (water equivalent) over forecast horizon',
        value: r => sum(...r.window('precipitation')) },
]

// Today's forecast (local calendar day), published on environment.forecast.today.* -
// all or nothing with the 'today' option, independent of the measurement groups.
const DAILY = [
    { group: 'temperature', path: 'temperature.minimum', units: 'K', api: ['temperature_2m_min'], description: 'Today\'s minimum temperature' },
    { group: 'temperature', path: 'temperature.maximum', units: 'K', api: ['temperature_2m_max'], description: 'Today\'s maximum temperature' },
    { group: 'humidity', path: 'relativeHumidity.minimum', units: 'ratio', api: ['relative_humidity_2m_min'], description: 'Today\'s minimum relative humidity' },
    { group: 'humidity', path: 'relativeHumidity.maximum', units: 'ratio', api: ['relative_humidity_2m_max'], description: 'Today\'s maximum relative humidity' },
    { group: 'pressure', path: 'pressure.minimum', units: 'Pa', api: ['surface_pressure_min'], description: 'Today\'s minimum pressure at station elevation' },
    { group: 'pressure', path: 'pressure.maximum', units: 'Pa', api: ['surface_pressure_max'], description: 'Today\'s maximum pressure at station elevation' },
    { group: 'precipitation', path: 'precipitation.probability', units: 'ratio', api: ['precipitation_probability_max'], description: 'Today\'s maximum probability of precipitation' },
    { group: 'precipitation', path: 'precipitation.rain', units: 'mm', api: ['rain_sum', 'showers_sum'], description: 'Today\'s rain incl. showers',
        value: r => sum(r.raw('rain_sum'), r.raw('showers_sum')) },
    { group: 'precipitation', path: 'precipitation.snow', units: 'mm', api: ['snowfall_sum'], description: 'Today\'s snowfall, water equivalent',
        value: r => snowWaterEquivalent(r.raw('snowfall_sum'), r.unit('snowfall_sum')) },
    { group: 'wind', path: 'wind.gust', units: 'm/s', api: ['wind_gusts_10m_max'], description: 'Today\'s maximum wind gusts' },
    { group: 'weather', path: 'weather.code', units: '', api: ['weather_code'], description: 'Today\'s most severe WMO weather code' },
    { group: 'weather', path: 'description', units: '', api: ['weather_code'], description: 'Today\'s weather condition',
        value: r => weatherDescription(r.raw('weather_code')) },
]

// Sunrise / sunset - only published together with current conditions (as OpenWeather does).
const SUNLIGHT = [
    { path: 'sunrise', units: '', api: ['sunrise'], description: 'Sunrise time (UTC)' },
    { path: 'sunset', units: '', api: ['sunset'], description: 'Sunset time (UTC)' },
]

// Marine forecast at <offset>, published on environment.forecast.* (group 'sea').
const MARINE = [
    { path: 'water.temperature', units: 'K', api: ['sea_surface_temperature'], description: 'Sea surface temperature' },
    { path: 'waves.combinedHeight', units: 'm', api: ['wave_height'], description: 'Significant height of combined wind waves and swell' },
    { path: 'waves.primaryDirection', units: 'rad', api: ['wave_direction'], description: 'Mean direction of combined waves (coming from), clockwise from North' },
    { path: 'waves.meanPeriod', units: 's', api: ['wave_period'], description: 'Mean period of combined waves' },
    { path: 'current.speed', units: 'm/s', api: ['ocean_current_velocity'], description: 'Ocean current speed' },
    { path: 'current.direction', units: 'rad', api: ['ocean_current_direction'], description: 'Ocean current direction (flowing towards), clockwise from North' },
]

function minimum(values) { return values.length ? Math.min(...values) : null }
function maximum(values) { return values.length ? Math.max(...values) : null }

// Hourly values are sums of the preceding hour; the current block covers <interval> seconds.
function perHour(value, ctx) {
    if (isMissing(value)) return null
    return ctx && ctx.interval ? value * 3600 / ctx.interval : value
}

// ── Response access ──────────────────────────────────────────────────────────
// A row is a view on one time step of one block (hourly | daily | current) for
// one model. With several models Open-Meteo suffixes every variable: temperature_2m_icon_seamless
function createRow(data, block, index, options = {}) {
    const values = data[block] || {}
    const units = data[block + '_units'] || {}
    const key = name => options.suffix ? `${name}_${options.suffix}` : name
    const series = name => Array.isArray(values[key(name)]) ? values[key(name)] : []
    const row = {
        raw: name => {
            const v = index === null ? values[key(name)] : series(name)[index]
            return isMissing(v) ? null : v
        },
        unit: name => units[key(name)],
        sk: name => toSK(row.unit(name), row.raw(name)),
        window: name => series(name).slice(options.windowStart || 0, (options.windowStart || 0) + (options.horizon || 0))
            .filter(v => !isMissing(v)),
    }
    return row
}

function evaluate(definition, row, ctx) {
    return definition.value ? definition.value(row, ctx) : row.sk(definition.api[0])
}

// Index of the hour that contains <now> (Open-Meteo hourly time is the start of the hour, unix seconds).
function currentHourIndex(times, now) {
    const t = Math.floor(now / 1000)
    for (let i = times.length - 1; i >= 0; i--)
        if (times[i] <= t) return i
    return times.length ? 0 : -1
}

function isValidPosition(pos) {
    return pos && typeof pos.latitude === 'number' && typeof pos.longitude === 'number' &&
        !Number.isNaN(pos.latitude) && !Number.isNaN(pos.longitude) &&
        pos.latitude >= -90 && pos.latitude <= 90 && pos.longitude >= -180 && pos.longitude <= 180
}

// Great-circle distance in metres.
function distance(a, b) {
    const rad = Math.PI / 180
    const dLat = (b.latitude - a.latitude) * rad
    const dLon = (b.longitude - a.longitude) * rad
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2
    return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

function clamp(value, fallback, { min, max }) {
    const n = Number(value)
    if (value === undefined || value === null || value === '' || Number.isNaN(n)) return fallback
    return Math.min(Math.max(Math.round(n), min), max)
}

// Distance for an in-between refresh in nm → m; empty / invalid disables it.
function refreshDistance(value) {
    const nm = Number(value)
    if (value === undefined || value === null || value === '' || Number.isNaN(nm) || nm <= 0) return null
    return convert.toSignalK('nm', Math.min(Math.max(nm, LIMITS.distance.min), LIMITS.distance.max)).value
}

// Normalises the plugin options - start({}) must work with defaults (SignalK CI).
function normalizeOptions(options = {}) {
    const known = MODELS.map(m => m.id)
    const model = known.includes(options.model) ? options.model : DEFAULTS.model
    // Optional second model, published in parallel on the same paths with its own $source.
    const model2 = known.includes(options.model2) && options.model2 !== model ? options.model2 : null
    const variables = options.variables || {}
    const groups = {}
    for (const [name, group] of Object.entries(GROUPS))
        groups[name] = typeof variables[name] === 'boolean' ? variables[name] : group.default
    return {
        apikey: typeof options.apikey === 'string' ? options.apikey.trim() : '',
        models: model2 ? [model, model2] : [model],
        offset: clamp(options.offset, DEFAULTS.offset, LIMITS.offset),
        horizon: clamp(options.horizon, DEFAULTS.horizon, LIMITS.horizon),
        current: options.current === true,
        today: typeof options.today === 'boolean' ? options.today : DEFAULTS.today,
        distance: refreshDistance(options.distance),
        cellSelection: ['sea', 'land', 'nearest'].includes(options.cellSelection) ? options.cellSelection : DEFAULTS.cellSelection,
        groups,
    }
}

// ── Request building ─────────────────────────────────────────────────────────
// A definition is selected when its group is selected; groups = null selects all.
function isSelected(definition, groups) {
    return !definition.group || !groups || groups[definition.group] === true
}

function apiVariables(definitions, groups, filter = () => true) {
    const vars = new Set()
    definitions.filter(d => isSelected(d, groups) && filter(d)).forEach(d => d.api.forEach(v => vars.add(v)))
    return [...vars]
}

function buildForecastUrl(config, position, altitude) {
    const hourly = [...apiVariables(MEASURES, config.groups), ...apiVariables(AGGREGATES, config.groups)]
    const daily = config.today ? apiVariables(DAILY, null) : []
    const current = config.current ? apiVariables(MEASURES, config.groups, d => d.current !== false) : []
    if (config.current) SUNLIGHT.forEach(d => daily.push(...d.api))

    const params = new URLSearchParams({
        latitude: position.latitude.toFixed(4),
        longitude: position.longitude.toFixed(4),
        models: config.models.join(','),
        forecast_hours: String(Math.max(config.offset, config.horizon) + 2),
        forecast_days: '1',
        timezone: 'auto',
        timeformat: 'unixtime',
        wind_speed_unit: 'ms',
        cell_selection: config.cellSelection,
    })
    if (hourly.length) params.set('hourly', [...new Set(hourly)].join(','))
    if (daily.length) params.set('daily', [...new Set(daily)].join(','))
    if (current.length) params.set('current', current.join(','))
    if (typeof altitude === 'number' && !Number.isNaN(altitude)) params.set('elevation', altitude.toFixed(1))
    if (config.apikey) params.set('apikey', config.apikey)
    return `${config.apikey ? ENDPOINTS.forecast.commercial : ENDPOINTS.forecast.free}?${params}`
}

function buildMarineUrl(config, position) {
    const params = new URLSearchParams({
        latitude: position.latitude.toFixed(4),
        longitude: position.longitude.toFixed(4),
        hourly: apiVariables(MARINE, { sea: true }).join(','),
        forecast_hours: String(config.offset + 2),
        timeformat: 'unixtime',
        wind_speed_unit: 'ms',
        cell_selection: 'sea',
    })
    if (config.apikey) params.set('apikey', config.apikey)
    return `${config.apikey ? ENDPOINTS.marine.commercial : ENDPOINTS.marine.free}?${params}`
}

// ── Response parsing → SignalK values ────────────────────────────────────────
function push(values, path, value) {
    if (!isMissing(value)) values.push({ path, value })
}

// Values for one model of a forecast response.
function forecastValues(data, config, model, now) {
    const suffix = config.models.length > 1 ? model : null
    const values = []
    const times = (data.hourly && data.hourly.time) || []
    const start = currentHourIndex(times, now)
    const target = start + config.offset

    if (start >= 0 && target < times.length) {
        push(values, PATH_FORECAST_TIME, new Date(times[target] * 1000).toISOString())
        const row = createRow(data, 'hourly', target, { suffix })
        MEASURES.filter(d => config.groups[d.group])
            .forEach(d => push(values, PATH_FORECAST + d.path, evaluate(d, row)))
        const window = createRow(data, 'hourly', target, { suffix, windowStart: start, horizon: config.horizon })
        AGGREGATES.filter(d => config.groups[d.group])
            .forEach(d => push(values, PATH_FORECAST + d.path, evaluate(d, window)))
    }

    if (data.daily) {
        const today = createRow(data, 'daily', 0, { suffix })
        if (config.today)
            DAILY.forEach(d => push(values, PATH_TODAY + d.path, evaluate(d, today)))
        if (config.current)
            SUNLIGHT.forEach(d => push(values, PATH_SUNLIGHT + d.path, evaluate(d, today)))
    }

    if (config.current && data.current) {
        const row = createRow(data, 'current', null, { suffix })
        const ctx = { interval: data.current.interval }
        MEASURES.filter(d => config.groups[d.group] && d.current !== false)
            .forEach(d => push(values, PATH_CURRENT + d.path, evaluate(d, row, ctx)))
    }
    return values
}

function marineValues(data, config, now) {
    const values = []
    const times = (data.hourly && data.hourly.time) || []
    const target = currentHourIndex(times, now) + config.offset
    if (times.length && target < times.length) {
        const row = createRow(data, 'hourly', target)
        MARINE.forEach(d => push(values, PATH_FORECAST + d.path, evaluate(d, row)))
    }
    return values
}

// Meta for every path the configuration can publish.
function buildMeta(config) {
    const entries = [{ path: PATH_FORECAST_TIME, units: '', description: 'Time the forecast values are valid for' }]
    const add = (prefix, definitions, filter = () => true, groups = config.groups) => definitions
        .filter(d => isSelected(d, groups) && filter(d))
        .forEach(d => entries.push({ path: prefix + d.path, units: d.units, description: d.description }))
    add(PATH_FORECAST, MEASURES)
    add(PATH_FORECAST, AGGREGATES)
    if (config.today) add(PATH_TODAY, DAILY, undefined, null)
    if (config.current) {
        add(PATH_CURRENT, MEASURES, d => d.current !== false)
        add(PATH_SUNLIGHT, SUNLIGHT)
    }
    if (config.groups.sea) add(PATH_FORECAST, MARINE)
    return entries.map(e => ({
        path: e.path,
        value: Object.assign(e.units ? { units: e.units } : {}, { description: e.description, timeout: META_TIMEOUT }),
    }))
}

class RequestError extends Error {
    constructor(message, status) {
        super(message)
        this.status = status
    }
}

// ── Forecast service ─────────────────────────────────────────────────────────
class OpenMeteo {
    /**
     * @param {object} host
     * @param {string} host.id - plugin id, prefix of the $source labels
     * @param {function} host.emit - receives a complete delta ({ updates: [...] })
     * @param {function} host.status - plugin status message
     * @param {function} host.error - plugin error message
     * @param {function} [host.getSelfPath] - reads the vessel's own data model
     * @param {function} [host.fetch] - fetch implementation (tests)
     */
    constructor(host) {
        this.host = host
        this.fetch = host.fetch || globalThis.fetch
        this.config = null
        this.timer = null
        this.generation = 0
        this.reset()
    }

    reset() {
        this.position = null
        this.altitude = null
        this.lastFetch = null
        this.lastFetchPosition = null
        this.lastFailure = null
        this.lastError = null
        this.failures = 0
        this.pending = null
    }

    get subscriptions() {
        return [
            { path: NAV_POSITION, period: ONE_MINUTE, policy: 'instant', minPeriod: ONE_MINUTE },
            { path: NAV_ALTITUDE, period: ONE_HOUR, policy: 'instant', minPeriod: 5 * ONE_MINUTE },
        ]
    }

    /** Applies the configuration, publishes meta and starts the scheduler. */
    start(options) {
        this.stop()
        this.reset()
        this.config = normalizeOptions(options)
        this.generation++
        this.host.emit({ updates: [{ meta: buildMeta(this.config) }] })
        log(`Configuration: ${JSON.stringify(Object.assign({}, this.config, { apikey: this.config.apikey ? '***' : '' }))}`)
        this.host.status(`Waiting for ${NAV_POSITION}`)

        this.timer = setInterval(() => this.tick(), TICK_INTERVAL)
        if (this.timer.unref) this.timer.unref()

        // Use what the server already knows; subscriptions deliver later updates.
        if (typeof this.host.getSelfPath === 'function') {
            this.onAltitude(this.readSelf(NAV_ALTITUDE))
            this.onPosition(this.readSelf(NAV_POSITION))
        }
    }

    stop() {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        this.config = null
        this.generation++   // results of in-flight requests are discarded
    }

    readSelf(path) {
        try {
            const node = this.host.getSelfPath(path)
            return node && typeof node === 'object' && 'value' in node ? node.value : node
        } catch (e) {
            return undefined
        }
    }

    onDelta(delta) {
        if (!delta || !Array.isArray(delta.updates)) return
        delta.updates.forEach(u => (u.values || []).forEach(v => {
            if (v.path === NAV_POSITION) this.onPosition(v.value)
            else if (v.path === NAV_ALTITUDE) this.onAltitude(v.value)
        }))
    }

    onPosition(value) {
        if (!isValidPosition(value)) return
        this.position = { latitude: value.latitude, longitude: value.longitude }
        this.tick()
    }

    onAltitude(value) {
        if (typeof value === 'number' && !Number.isNaN(value)) this.altitude = value
    }

    /** Back-off after <failures> consecutive failed requests: 1, 2, 4, 8, 15, 15, ... min */
    retryDelay() {
        return Math.min(RETRY_MIN * 2 ** Math.max(this.failures - 1, 0), RETRY_MAX)
    }

    /**
     * Decides whether a new request is due:
     * - first position, or retry after a failure once the back-off elapsed
     * - one hour after the last update - checked one tick early, so that new values
     *   arrive before the published ones reach their meta timeout
     * - in between, when the vessel moved <distance> since the last update (optional)
     */
    isDue(now) {
        if (!this.config || !this.position || this.pending) return false
        if (this.failures > 0) return now - this.lastFailure >= this.retryDelay()
        if (this.lastFetch === null) return true
        if (now - this.lastFetch >= REFRESH_INTERVAL - TICK_INTERVAL) return true
        return this.config.distance !== null &&
            distance(this.position, this.lastFetchPosition) >= this.config.distance
    }

    tick(now = Date.now()) {
        if (this.isDue(now)) this.pending = this.refresh(now).finally(() => { this.pending = null })
        return this.pending
    }

    /** Requests forecast (and marine) data and publishes it. Never rejects. */
    async refresh(now = Date.now()) {
        const generation = this.generation
        const config = this.config
        const position = Object.assign({}, this.position)
        try {
            const marineRequest = config.groups.sea
                ? this.request(buildMarineUrl(config, position)).catch(e => e)
                : Promise.resolve(null)
            const data = await this.request(buildForecastUrl(config, position, this.altitude))
            const marine = await marineRequest
            if (generation !== this.generation) return   // stopped or restarted meanwhile

            const updates = config.models
                .map(model => ({ $source: `${this.host.id}.${model}`, values: forecastValues(data, config, model, now) }))
                .filter(u => u.values.length > 0)
            if (marine && !(marine instanceof Error)) {
                const values = marineValues(marine, config, now)
                if (values.length) updates.push({ $source: `${this.host.id}.marine`, values })
            } else if (marine instanceof Error) {
                log(`Marine forecast unavailable: ${marine.message}`)
            }
            if (updates.length) this.host.emit({ updates })

            if (this.failures > 0)
                log(`Open-Meteo reachable again after ${this.failures} failed request(s) since ${new Date(this.lastFailure).toISOString()}`)
            this.lastFetch = now
            this.lastFetchPosition = position
            this.lastFailure = null
            this.lastError = null
            this.failures = 0
            const valid = updates.length ? updates[0].values.find(v => v.path === PATH_FORECAST_TIME) : null
            this.host.status(`Forecast ${config.models.join(', ')}` +
                (valid ? ` for ${valid.value}` : '') +
                ` at ${position.latitude.toFixed(2)}, ${position.longitude.toFixed(2)}` +
                (marine instanceof Error ? ' (marine data unavailable)' : ''))
        } catch (e) {
            if (generation !== this.generation) return
            // Offline periods (no internet at sea) must not flood the logs: report an
            // error once and whenever it changes, repeated failures go to the debug log only.
            this.failures++
            this.lastFailure = now
            if (e.message !== this.lastError) this.host.error(e.message)
            this.lastError = e.message
            log(`${e.message} - attempt ${this.failures}, next retry in ${this.retryDelay() / ONE_MINUTE} min`)
        }
    }

    async request(url) {
        log(`GET ${url.replace(/apikey=[^&]*/, 'apikey=***')}`)
        let response
        try {
            response = await this.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
        } catch (e) {
            // fetch reports network problems as 'fetch failed' - the cause holds the reason (ENOTFOUND, ECONNREFUSED, ...)
            const reason = e.name === 'TimeoutError' ? `no response within ${REQUEST_TIMEOUT / 1000} s`
                : (e.cause && (e.cause.code || e.cause.message)) || e.message
            throw new RequestError(`Open-Meteo unreachable: ${reason}`)
        }
        let body = null
        try { body = await response.json() } catch (e) { body = null }
        if (!response.ok || !body || body.error) {
            const reason = body && body.reason ? body.reason : `HTTP ${response.status}`
            if (response.status === 401 || response.status === 403)
                throw new RequestError(`Open-Meteo API key rejected: ${reason}`, response.status)
            if (response.status === 429)
                throw new RequestError(`Open-Meteo rate limit exceeded: ${reason}`, response.status)
            throw new RequestError(`Open-Meteo request failed: ${reason}`, response.status)
        }
        return body
    }
}

module.exports = {
    OpenMeteo,
    MODELS,
    GROUPS,
    DEFAULTS,
    LIMITS,
    // exported for tests
    normalizeOptions,
    buildForecastUrl,
    buildMarineUrl,
    forecastValues,
    marineValues,
    buildMeta,
    toSK,
    weatherIcon,
}

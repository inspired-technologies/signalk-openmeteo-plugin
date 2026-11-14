# signalk-openmeteo-plugin
SignalK Plugin to inject current conditions and forecast data from the __[Open-Meteo](https://open-meteo.com/)__ weather service - with a choice of weather models from national weather services (ECMWF, DWD ICON, NOAA GFS, Météo-France, UK Met Office, ...).

## Install & Use
Install the plugin through the SignalK App Store. After installation 'Activate' it through the SignalK Plugin Config interface and select:
- **Weather model** (required) - `best_match` lets Open-Meteo combine the most suitable models for your location, or pick a specific model
- **Second weather model** (optional) - published in parallel on the same paths with its own `$source` (see [Sources](#sources))
- **Forecast offset** - the forecast is published for the full hour `<offset>` hours ahead (default 1)
- **Forecast horizon** - hours ahead used for minimum / maximum / accumulated values (default 24)
- **Refresh distance** (optional, nm) - refresh in between when the vessel moved this distance since the last update; leave empty for the hourly refresh only
- **Today's forecast** - publish today's values on `environment.forecast.today.*` (all or nothing, default on)
- **Measurements** - groups of values to publish:
  - Temperature at 2 m, incl. apparent temperature and dew point
  - Relative humidity at 2 m
  - Atmospheric pressure at station elevation
  - Wind at 10 m incl. gusts
  - Precipitation - probability, rain, snow, accumulated
  - Weather condition - WMO code, description and icon
  - Cloud cover, visibility and UV index
  - Convective potential energy and lifted index
  - Snow depth
  - Waves, ocean current and water temperature (Open-Meteo Marine API)
- **Current conditions** - optionally publish on `environment.outside.*`; turn this on only if no other sensors (e.g. BME280, RuuviTag) provide outside conditions.

### API key
Open-Meteo is free for non-commercial use within its fair-use limits and needs no API key - the plugin works out of the box. **The plugin does not come with an API key.** Commercial or heavy users have to acquire their own key from Open-Meteo (see [pricing](https://open-meteo.com/en/pricing)) and enter it in the plugin configuration; the plugin then uses the customer API servers.

## Forecast Data
Forecast data is purely based on position - hence `navigation.position` needs to be present. Data is requested on the first position, then one hour after the last update and - if a refresh distance is configured - in between as soon as the vessel moved that distance since the last update. `navigation.gnss.antennaAltitude` is used, if present, as elevation for the forecast, so that pressure and temperature apply to the station elevation; otherwise sea level (or the terrain elevation ashore) is assumed. No information will be stored or tracked.

### Offline operation
Without internet connection (e.g. at sea) the plugin keeps running quietly: the failure is reported once in the plugin status, retries back off from 1 up to 15 minutes and are only noted in the debug log. Requests are not queued - the next successful request publishes the latest forecast for the current position. Published values expire after one hour (meta `timeout`), so outdated forecasts are not shown as current.

### Logging
Enable *Debug log* in the plugin configuration (debug namespace `openmeteo-signalk`) for a readable summary in the server log: the configured models and what is published on start, each received forecast with the number of values per model and the time of the next update, and connectivity problems with retry and recovery. Request URLs and the API key are never logged.

The plugin publishes, depending on the selected measurements:

| Path | Content |
|---|---|
| `environment.forecast.time` | time the forecast values are valid for |
| `environment.forecast.*` | forecast for the full hour `<offset>` hours ahead, e.g. `temperature`, `relativeHumidity`, `pressure`, `wind.*`, `precipitation.*`, `weather.*`, `description` |
| `environment.forecast.temperature.minimum/maximum` | over the forecast horizon |
| `environment.forecast.precipitation.accumulated` | over the forecast horizon |
| `environment.forecast.today.*` | today's (local day) min / max temperature, humidity and pressure, rain, snow, precipitation probability, maximum gusts and weather (optional) |
| `environment.forecast.waves.*`, `current.*`, `water.temperature` | marine forecast at `<offset>` |
| `environment.outside.*` | current conditions (optional) |
| `environment.sunlight.times.sunrise/sunset` | together with current conditions |

All values follow the SignalK units (K, Pa, ratio, m/s, rad, m) - precipitation is published in mm/h (mm for sums), as in the OpenWeather plugin. Meta data incl. units, description and a timeout is published at start.

### Sources
Values are published with the `$source` `openmeteo-signalk.<model>` (marine data: `openmeteo-signalk.marine`), so the model a value is based on is always visible. With a second model both models publish on the same paths, each with its own `$source` (e.g. `openmeteo-signalk.icon_seamless` and `openmeteo-signalk.ecmwf_ifs025`). A model only publishes the values it provides - e.g. ECMWF provides no visibility.

On servers with source priority groups (*Data → Priorities*) the plugin ranks both models as group `openmeteo-signalk` on every start: consumers receive the first model, the second one fills only the paths the first does not provide. The group is kept in memory and saved only when priorities are saved in the admin UI; the configured model order always wins on the next start. Models ranked by the user in another group are left untouched.

Other plugins publishing the same paths more often than hourly (e.g. the OpenWeather plugin) take over a path shortly after each hourly update - priorities fail over after a few seconds without data. Disable that source for the shared paths in *Data → Priorities*, or do not run both plugins for the same paths.

### Weather codes
`weather.code` is a [WMO weather interpretation code](https://open-meteo.com/en/docs#weather_variable_documentation). `weather`, `description` and `weather.icon` are derived from it following the conventions of the OpenWeather plugin (e.g. `Clouds`, `overcast`, `04d`).

## Attribution
Weather data by [Open-Meteo.com](https://open-meteo.com/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Release Notes
See [Changelog](CHANGELOG.md).

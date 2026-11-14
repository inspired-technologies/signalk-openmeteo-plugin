# Change Log

## [0.1]
- Initial Release.
- Forecast for the full hour `<offset>` ahead from a selectable Open-Meteo weather model, published with `$source` `openmeteo-signalk.<model>`.
- Optional second model, published in parallel on the same paths with its own `$source` and ranked as source priority group (first model wins, second fills gaps).
- Optional today's forecast (min / max temperature, humidity, pressure, precipitation, gusts, weather) on `environment.forecast.today.*`.
- Hourly refresh, optional in-between refresh after a configurable distance (nm).
- Resilient to long offline periods: single error report, back-off up to 15 min, no request backlog.
- Readable debug log: configuration summary, forecast received with next update, connectivity and recovery - no request URLs or API keys.
- Measurement groups on par with the OpenWeather and SquidSailing plugins, incl. storm indices, snow depth and marine data (waves, current, water temperature).
- Optional current conditions on `environment.outside.*`.
- SignalK Plugin CI and automated tests.

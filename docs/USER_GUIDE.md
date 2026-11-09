# EarthFire user guide

EarthFire is an interactive explorer for NASA FIRMS active-fire observations from MODIS and VIIRS. Use it to explore where satellite detections were recorded, compare sensor activity, and see how observations changed over the available dates.

**Open EarthFire:** [earthfire.onrender.com](https://earthfire.onrender.com/)

## Quick start

1. Open the website and wait for the dashboard to connect. The free hosted service can take a little while to wake up after it has been idle.
2. Choose a region from the region menu. The dashboard updates its summary and map for that region.
3. Choose a date in the date control or select a month and year in the fire calendar.
4. Explore the globe, timeline, sensor layers and chart using the sections below.

Dates are shown in **UTC**. Coverage depends on the data available for the selected region and period; a date with no detections is different from a date that has not been loaded.

## Explore the globe

### Rotate, zoom and search

- Drag the globe to rotate it.
- Scroll over the globe to zoom on a computer. On a phone or tablet, pinch to zoom and drag to rotate.
- Use **Search for a country** below the globe to focus the view on a country and show hotspot cells for it.
- Country search and the region menu serve different purposes: the region menu selects a dashboard region, while country search focuses the globe on a country.

### Read and select hotspots

The colored markers show occupied grid cells for the selected day and layer. Click a marker to open its detail card. Depending on the cell and available data, the card shows its country, observation date, coordinates, MODIS and VIIRS detection counts and FRP, cell area, density, and combined FRP.

These are satellite observations grouped onto a shared 0.5° daily grid. A marker represents the center of an occupied cell; it is not a fire perimeter or a verified individual fire. The combined FRP display is an exploratory sum of sensor values, not a deduplicated fire-level measurement.

### Choose a sensor layer

Use the buttons beneath the globe to switch between:

- **Harmonized:** occupied cells from either sensor on the shared grid.
- **MODIS:** cells with MODIS detections.
- **VIIRS:** cells with VIIRS detections.

This helps you compare sensor coverage and activity. MODIS and VIIRS have different spatial resolutions and overpass times, so their counts should not be interpreted as interchangeable measurements.

## Explore activity over time

### Fire calendar

Use the month and year menus to browse available history. Select a day to update the daily snapshot and globe. The calendar's “days with detections” total counts UTC dates with at least one occupied cell in the displayed month; it does not count individual fires.

If a period reports insufficient history or missing coverage, EarthFire does not have enough loaded, comparable sensor observations for that view. NASA source availability and gaps can limit how far back data can be explored.

### Timeline playback

Use **Play timeline** or drag the slider below the globe to move through the dates currently loaded for the selected region or calendar month. Playback changes the selected date so you can watch occupied cells appear and change. It only plays dates already loaded; it does not fetch an entire historical range by itself.

### Activity chart

In **Activity over time**, select **Detections** or **FRP** to change the chart metric. MODIS and VIIRS remain separate series. The harmonized series represents occupied grid cells for detections and an exploratory FRP proxy for FRP.

This view can help reveal changes and peaks over the displayed period. It is an exploratory summary, not a forecast or a wildfire risk score.

## Follow a region and enable alerts

1. Choose one of the named regions in the region menu.
2. Select **Follow [region]** below the globe to save it in this browser.
3. Select **Enable hotspot alerts** and allow notifications when your browser asks.

Followed region names are stored locally in the browser, not in an EarthFire account. Alerts are tied to the active region's background FIRMS sync: when the loaded 30-day detection total increases after a sync, EarthFire may show one browser notification for that region per day. Keep the dashboard open for its sync to run. This is not a continuous emergency alert service, and it does not send notifications while the browser is closed.

To stop following a region, select its **Following [region]** button again. You can also turn off notifications in your browser's site settings.

## Export observations and charts

- Select **CSV** in the activity chart controls to download the currently loaded grid-cell/day observations. The file includes fields such as date, cell coordinates, sensor counts and FRP, area and density. It contains harmonized cell data, not raw FIRMS rows.
- Select **Chart** to save the displayed trend plot as an SVG image. SVG can be opened in a browser or many image and design tools.

Exports reflect the data currently loaded in the dashboard. Choose the region or historical month first if you need a different view.

## What users can get from EarthFire

- **Students and educators** can explore satellite observations and see a concrete example of mapping data to a common daily grid.
- **Researchers and analysts** can inspect regional patterns, compare MODIS and VIIRS series, and export cell-level summaries for further exploration.
- **Journalists and community groups** can use the calendar and trend chart to review when detections were observed in an area.
- **Project teams** can use the same views to communicate data coverage, compare sensors and discuss changes over time.

The main benefit is a quick, interactive way to explore and communicate satellite fire observations. EarthFire does not confirm individual fires, estimate burned area, or provide official emergency guidance. For decisions about safety or response, consult local authorities and official incident sources.

## Data and interpretation notes

- Data comes from NASA FIRMS active-fire products. New observations can arrive with a delay.
- Dates are interpreted in UTC, and the map groups detections by day and 0.5° cell.
- Clouds, satellite overpass timing, sensor differences and data gaps affect what is detected.
- An empty cell or day does not prove that no fire exists.
- EarthFire is an exploratory data viewer, not an operational alerting or emergency-response system.

For the processing method, software setup, deployment, API endpoints and scientific limitations, see the [detailed project documentation](PROJECT_DOCUMENTATION.md) and repository [README](../README.md).

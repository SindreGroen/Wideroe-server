const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- KONFIGURASJON ---
const AIRPORT_CODE = 'BGO';
const HOURS_BACK = 24; 
const HOURS_FORWARD = 4; // Ser fremover for å finne avganger
const CACHE_DURATION = 180 * 1000; // 3 minutter cache

// --- TIDSREGLER (Minutter) ---

// ANKOMST: Vis fly som landet for mellom 15 og 60 minutter siden
const ARR_MIN_AGE = 15; 
const ARR_MAX_AGE = 60;

// AVGANG: Vis fly som skal dra om mellom 15 og 90 minutter
const DEP_MIN_FUTURE = 15; // Ikke vis hvis det er mindre enn 15 min til (boarding ferdig)
const DEP_MAX_FUTURE = 90; // Vis opp til 1,5 time før

// --- SVARTELISTE FLIGHT ID ---
// Fly som er i denne listen vil ALDRI bli sendt til skjermen.
const BLOCKED_IDS = [
    // Ørsta/Volda & Sogndal
    "WF150", "WF151", "WF152", "WF153", 
    "WF158", "WF159", "WF163", "WF170",

    // Ålesund (Til/Fra Bergen)
    // Har inkludert både WF456 (logisk rekkefølge) og WF466 (fra din liste) for sikkerhets skyld.
    "WF451", "WF452", "WF453", "WF454", "WF455", 
    "WF456", "WF466", // Sikring
    "WF457", "WF458", "WF459", "WF460", "WF461", "WF462"
];

const airportNames = {
    "OSL": "OSLO", "SVG": "STAVANGER", "TRD": "TRONDHEIM", "TOS": "TROMSØ",
    "BOO": "BODØ", "AES": "ÅLESUND", "KRS": "KRISTIANSAND", "HAU": "HAUGESUND",
    "MOL": "MOLDE", "KSU": "KRISTIANSUND", "EVE": "EVENES", "ALF": "ALTA",
    "FRO": "FLORØ", "HOV": "ØRSTA/VOLDA", "SDN": "SANDANE", "SOG": "SOGNDAL",
    "FDE": "FØRDE", "BGO": "BERGEN", "CPH": "KØBENHAVN", "ABZ": "ABERDEEN",
    "LHR": "LONDON", "LGW": "LONDON", "STN": "LONDON", "LTN": "LONDON",
    "BRU": "BRUSSEL", "LKN": "LEKNES", "SSJ": "SANDNESSJØEN", "KKN": "KIRKENES",
    "AMS": "AMSTERDAM", "FRA": "FRANKFURT", "GDN": "GDANSK", "WAW": "WARSZAWA",
    "ARN": "STOCKHOLM", "KEF": "REYKJAVIK", "GOT": "GØTEBORG", "HEL": "HELSINKI",
    "EDI": "EDINBURGH", "BLL": "BILLUND", "HAM": "HAMBURG", "MUC": "MÜNCHEN",
    "ALC": "ALICANTE", "AGP": "MALAGA", "PMI": "PALMA", "LPA": "GRAN CANARIA",
    "TRF": "SANDEFJORD", "RRS": "RØROS", "RYG": "RYGGE"
};

let cachedData = null;
let lastFetchTime = 0;
const agent = new https.Agent({ rejectUnauthorized: false });

async function fetchFromAvinor() {
    try {
        const now = new Date();
        const start = new Date(now.getTime() - (HOURS_BACK * 60 * 60 * 1000));
        const end = new Date(now.getTime() + (HOURS_FORWARD * 60 * 60 * 1000));

        const timeFrom = start.toISOString().split('.')[0]; 
        const timeTo = end.toISOString().split('.')[0];
        const baseUrl = "https://asrv.avinor.no/XmlFeed/v1.0";
        
        // Henter både Ankomster (A) og Avganger (D)
        const urlArr = `${baseUrl}?airport=${AIRPORT_CODE}&timeFrom=${timeFrom}&timeTo=${timeTo}&direction=A`;
        const urlDep = `${baseUrl}?airport=${AIRPORT_CODE}&timeFrom=${timeFrom}&timeTo=${timeTo}&direction=D`;

        console.log(`📡 Henter data fra Avinor...`);

        const [resArr, resDep] = await Promise.all([
            axios.get(urlArr, { httpsAgent: agent, headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml' } }),
            axios.get(urlDep, { httpsAgent: agent, headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml' } })
        ]);

        const parseFlights = async (xmlData) => {
            let flights = [];
            if (typeof xmlData === 'string' && (xmlData.includes('<?xml') || xmlData.includes('<airport'))) {
                const parser = new xml2js.Parser();
                const result = await parser.parseStringPromise(xmlData);
                if (result.airport && result.airport.flights && result.airport.flights[0].flight) {
                    flights = result.airport.flights[0].flight;
                }
            } else if (typeof xmlData === 'object' && xmlData.flights) {
                flights = xmlData.flights;
            }
            return flights;
        };

        const flightsArr = await parseFlights(resArr.data);
        const flightsDep = await parseFlights(resDep.data);
        const allFlights = [...flightsArr, ...flightsDep];

        if (allFlights.length === 0) return null;

        const result = {
            arrivals: { relevant: [], archive: [] },
            departures: { relevant: [], archive: [] }
        };

        allFlights.forEach(f => {
            let flightId = Array.isArray(f.flight_id) ? f.flight_id[0] : f.flight_id;
            let time = Array.isArray(f.schedule_time) ? f.schedule_time[0] : f.schedule_time;
            
            // Sjekk retning: A = Arrival, D = Departure
            let direction = Array.isArray(f.arr_dep) ? f.arr_dep[0] : f.arr_dep;

            if (!flightId || !flightId.startsWith("WF")) return; 
            
            // --- SVARTELISTE SJEKK ---
            // Fjerner eventuelle mellomrom (eks "WF 451" -> "WF451") for å matche listen vår
            const normalizedId = flightId.replace(/\s+/g, '');
            if (BLOCKED_IDS.includes(normalizedId)) return;

            if (f.status) {
                let statusCode = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.code : (f.status.code || "");
                let statusTime = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.time : (f.status.time || "");
                if ((statusCode === 'A' || statusCode === 'E' || statusCode === 'D') && statusTime) time = statusTime;
            }

            if (flightId.length > 6) flightId = flightId.substring(0, 6);
            let fromCode = Array.isArray(f.airport) ? f.airport[0] : f.airport;
            const cityName = airportNames[fromCode] || fromCode;

            const flightTime = new Date(time);
            const isToday = flightTime.toDateString() === now.toDateString();
            
            // Diff i minutter
            const minutesDiff = (now - flightTime) / 1000 / 60; 

            const flightObj = { id: flightId, from: cityName, time: time, type: direction };

            if (direction === 'A') {
                // --- ANKOMST ---
                if (isToday && minutesDiff > 0) { // Har landet
                    if (minutesDiff > ARR_MIN_AGE && minutesDiff < ARR_MAX_AGE) {
                        result.arrivals.relevant.push(flightObj);
                    } else {
                        result.arrivals.archive.push(flightObj);
                    }
                }
            } else if (direction === 'D') {
                // --- AVGANG ---
                const minutesToTakeoff = -minutesDiff;

                if (isToday && minutesToTakeoff > 0) { // Skal dra i fremtiden
                    if (minutesToTakeoff > DEP_MIN_FUTURE && minutesToTakeoff < DEP_MAX_FUTURE) {
                        result.departures.relevant.push(flightObj);
                    } else {
                        result.departures.archive.push(flightObj);
                    }
                }
            }
        });

        // Sortering
        result.arrivals.relevant.sort((a, b) => new Date(b.time) - new Date(a.time));
        result.departures.relevant.sort((a, b) => new Date(a.time) - new Date(b.time));

        return result;

    } catch (error) {
        console.error("❌ Feil:", error.message);
        return null;
    }
}

app.get('/api/flights', async (req, res) => {
    const now = Date.now();
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        console.log("♻️  Cache");
        return res.json(cachedData);
    }
    const freshData = await fetchFromAvinor();
    if (freshData) {
        cachedData = freshData;
        lastFetchTime = now;
        console.log(`✅ Data: Arr: ${freshData.arrivals.relevant.length}, Dep: ${freshData.departures.relevant.length}`);
        res.json(freshData);
    } else {
        if (cachedData) res.json(cachedData);
        else res.json({ arrivals: { relevant: [], archive: [] }, departures: { relevant: [], archive: [] } }); 
    }
});

app.listen(PORT, () => console.log(`🚀 Server på port ${PORT}`));

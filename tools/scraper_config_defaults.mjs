// Single source of truth for the offline scraper's search settings. Both
// tools/offline_scraper.mjs and tools/dashboard_server.mjs import this - the
// scraper uses it as a fallback when job_scraper/scraper_config.json doesn't
// exist yet (fresh clone), and the dashboard server uses it to seed that file
// the first time someone opens the "Search settings" panel.
//
// Editing search keywords/locations day-to-day should happen through the
// dashboard (tools/open_dashboard.bat -> Search settings) or by hand-editing
// job_scraper/scraper_config.json - not here. This file only defines what a
// fresh setup starts with.

export const DEFAULT_CONFIG = {
  // Relevance: study programs to match on MagangHub, words that drop a posting, and the filter for broad portals
  majors: [], excludeKeywords: [], broadPortalFilter: true,
  // Auto-run schedule (24h local time, HH:MM). Used by the dashboard server and the Android app.
  schedule: { enabled: false, times: ['08:00', '19:00'] },
  // Named, independently-runnable groups of keywords - each shows as its own
  // card in the dashboard's Search settings panel, with its own "Run" button
  // and an enabled/disabled toggle. `enabled: false` groups are skipped by
  // the combined "Run scraper now" button but can still be run individually.
  // A single flat `keywords: [...]` array (the pre-groups format) is still
  // read and auto-migrated into one "Default" group - see loadConfig() in
  // offline_scraper.mjs - so older job_scraper/scraper_config.json files
  // keep working without any manual edits.
  keywordGroups: [
    {
      name: 'Magang',
      enabled: true,
      keywords: [
        // Role-based (English)
        'AI Engineer Intern',
        'IoT Engineer Intern',
        'Embedded Systems Intern',
        'Machine Learning Intern',
        'Automation Intern',
        'Electrical Engineering Intern',
        'Electrical Maintenance',
        'Electrical Engineering Apprenticeship',
        'Automation Apprenticeship',
        'Apprenticeship Electrical',
        'Instrumentation Intern',
        'PLC Intern',
        'Robotics Intern',
        'Software Engineer Intern',
        'Fullstack Developer Intern',

        // Magang (Indonesian - internship)
        'Magang Teknik Elektro',
        'Magang Elektro',
        'Magang Electrical',
        'Magang Maintenance',
        'Magang Otomasi',
        'Magang Embedded System',
        'Magang IoT',
        'Magang AI',
        'Magang PLC',
        'Magang Instrumentasi',
        'Magang IT',
        'Magang Fullstack',

        // Kerja Praktek / Kerja Praktik (Indonesian - university-required
        // practical placement; both spellings are common in real postings)
        'Kerja Praktek Teknik Elektro',
        'Kerja Praktik Teknik Elektro',
        'Kerja Praktek Elektro',
        'Kerja Praktek Otomasi',
        'Kerja Praktek IoT',
        'Kerja Praktek Embedded System',
        'Kerja Praktek PLC',
        'KP Teknik Elektro',

        // Student-targeted postings, incl. structured entry-level programs
        'Mahasiswa Teknik Elektro',
        'Mahasiswa Elektro',
        'Electrical Engineering Student',
        'Graduate Engineer Program',
        'Engineering Trainee',
        'SCADA Intern',
      ],
    },
  ],
  // How many result pages to pull per keyword, per portal. LinkedIn's own ToS
  // asks for low volume, so it defaults to 1; JobStreet defaults to 2.
  linkedinMaxPages: 1,
  jobstreetMaxPages: 2,
  // Cities/regions close to Surabaya (no relocation needed) vs. generally
  // workable vs. everything else (flagged "cek jarak" in results).
  idealLocations: ['surabaya', 'sidoarjo', 'gresik', 'mojokerto', 'jombang', 'lamongan'],
  acceptableLocations: ['jawa timur', 'east java', 'malang', 'jakarta', 'bandung', 'yogyakarta', 'remote'],
  // Skill/domain keywords from CLAUDE.md's candidate profile, used to compute
  // an offline "fit score" per posting (see computeFitScore in
  // offline_scraper.mjs) - how many of these show up in the full job
  // description. Pure keyword overlap, not real judgment of actual fit
  // (that still needs Claude reading the posting, e.g. via /rank) - tune
  // this list via the dashboard's Search settings panel if it over/under-matches.
  profileSkills: [
    'Python', 'PyTorch', 'TensorFlow', 'Scikit-learn', 'OpenCV', 'YOLO', 'ONNX',
    'ESP32', 'Arduino', 'ATmega', 'STM32', 'Raspberry Pi', 'embedded system',
    'JavaScript', 'Next.js', 'Flask', 'Flutter', 'PHP', 'SQL', 'C++', 'Dart', 'Node-RED',
    'AIoT', 'MLOps', 'machine learning', 'computer vision', 'artificial intelligence',
    'industrial automation', 'automation', 'robotics', 'PLC', 'SCADA', 'control system',
    'IoT', 'sensor', 'MQTT', 'MODBUS', 'OPC-UA',
    'electrical engineering', 'instrumentation', 'maintenance',
    'disaster', 'climate', 'early warning', 'monitoring system',
  ],
};

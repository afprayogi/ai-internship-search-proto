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
  // How many result pages to pull per keyword, per portal. LinkedIn's own ToS
  // asks for low volume, so it defaults to 1; JobStreet defaults to 2.
  linkedinMaxPages: 1,
  jobstreetMaxPages: 2,
  // Cities/regions close to Surabaya (no relocation needed) vs. generally
  // workable vs. everything else (flagged "cek jarak" in results).
  idealLocations: ['surabaya', 'sidoarjo', 'gresik', 'mojokerto', 'jombang', 'lamongan'],
  acceptableLocations: ['jawa timur', 'east java', 'malang', 'jakarta', 'bandung', 'yogyakarta', 'remote'],
};

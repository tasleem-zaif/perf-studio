require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

app.use('/api/auth',                                   require('./routes/auth'));
app.use('/api/orgs',                                   require('./routes/orgs'));
app.use('/api/admin',                                  require('./routes/admin'));
app.use('/api/projects',                               require('./routes/projects'));
app.use('/api/projects/:projectId/collections',        require('./routes/collections'));
app.use('/api/projects/:projectId/rules',              require('./routes/rules'));
app.use('/api/projects/:projectId/scripts',            require('./routes/scripts'));
app.use('/api/projects/:projectId/test-suites',        require('./routes/testSuites'));
app.use('/api/projects/:projectId/test-data',          require('./routes/testData'));
app.use('/api/projects/:projectId/config',             require('./routes/projectConfig'));
app.use('/api/projects/:projectId/collections/:collectionId/env-config', require('./routes/envConfig'));
app.use('/api/config',                                 require('./routes/config'));
app.use('/api/ai',                                     require('./routes/ai'));
app.use('/api/settings',                               require('./routes/settings'));
app.use('/api/runner',                                 require('./routes/runner'));
app.use('/api/execution',                              require('./routes/execution'));
app.use('/api/alerts',                                 require('./routes/alerts'));

// Serve generated project files (scripts, test data) for download
const { PROJECTS_ROOT } = require('./utils/projectFolders');
app.use('/projects-files', express.static(PROJECTS_ROOT));

app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Performance Studio API running on http://localhost:${PORT}`));

const express = require('express');
const router = express.Router();

const stravaController = require('../controllers/stravaController');
const aiController = require('../controllers/aiController');
const forecastController = require('../controllers/forecastController');
const scheduleController         = require('../controllers/scheduleController');
const nutritionController        = require('../controllers/nutritionController');
const authController             = require('../controllers/authController');
const googleCalendarController   = require('../controllers/googleCalendarController');

// Auth Routes
router.get( '/auth/profiles',  authController.getProfiles);
router.post('/auth/configure', authController.configure);
router.post('/auth/sample',    authController.useSample);

// Strava Data Routes
router.get('/athlete', stravaController.getAthlete);
router.get('/athlete/stats/:id', stravaController.getAthleteStats);
router.get('/activities', stravaController.getActivities);
router.get('/charts', stravaController.getCharts);
router.get('/stats', stravaController.getCharts); // Backward compatibility

// AI Agents
router.post('/analyse', aiController.analyse);
router.post('/chat', aiController.chat);
router.post('/forecast', forecastController.forecast);

// Nutrition RAG Agent
router.post('/nutrition', nutritionController.nutritionPlan);

// Google Calendar (existing MCP-based schedule)
router.get('/calendar/status', scheduleController.calendarStatus);
router.post('/schedule', scheduleController.schedule);

// Google Calendar OAuth (new per-user auth flow)
router.get( '/auth/google-calendar/status',     googleCalendarController.status);
router.post('/auth/google-calendar/disconnect', googleCalendarController.disconnectCalendar);
router.get( '/calendar/upcoming',               googleCalendarController.upcomingEvents);
router.post('/calendar/schedule',               googleCalendarController.scheduleWorkouts);
router.post('/calendar/add-workout',            googleCalendarController.addWorkout);

module.exports = router;

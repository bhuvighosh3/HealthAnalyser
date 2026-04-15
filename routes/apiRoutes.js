const express = require('express');
const router  = express.Router();

const stravaController          = require('../controllers/stravaController');
const aiController              = require('../controllers/aiController');
const forecastController        = require('../controllers/forecastController');
const googleCalendarController  = require('../controllers/googleCalendarController');
const nutritionController       = require('../controllers/nutritionController');
const authController            = require('../controllers/authController');

// Strava Auth
router.get( '/auth/profiles',  authController.getProfiles);
router.post('/auth/configure', authController.configure);
router.post('/auth/sample',    authController.useSample);

// Strava Data
router.get('/athlete',           stravaController.getAthlete);
router.get('/athlete/stats/:id', stravaController.getAthleteStats);
router.get('/activities',        stravaController.getActivities);
router.get('/charts',            stravaController.getCharts);
router.get('/stats',             stravaController.getCharts);

// AI Agents
router.post('/analyse',  aiController.analyse);
router.post('/chat',     aiController.chat);
router.post('/forecast', forecastController.forecast);

// Nutrition RAG
router.post('/nutrition', nutritionController.nutritionPlan);

// Google Calendar OAuth status + disconnect
router.get( '/auth/google-calendar/status',     googleCalendarController.status);
router.post('/auth/google-calendar/disconnect', googleCalendarController.disconnectCalendar);

// Google Calendar API
router.get( '/calendar/upcoming',    googleCalendarController.upcomingEvents);
router.post('/calendar/schedule',    googleCalendarController.scheduleWorkouts);
router.post('/calendar/add-workout', googleCalendarController.addWorkout);
router.post('/schedule',             googleCalendarController.scheduleWorkouts);

module.exports = router;

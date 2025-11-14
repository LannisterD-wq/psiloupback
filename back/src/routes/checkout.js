const { Router } = require('express');
const CheckoutController = require('../controllers/CheckoutController');
const { authRequired } = require('../middleware/auth');

const router = Router();

router.post('/quote', CheckoutController.quote);
router.get('/quote', CheckoutController.quote);
router.post('/create', authRequired, CheckoutController.createOrder);

module.exports = router;


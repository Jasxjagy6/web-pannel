const trackingDashboardService = require('../services/trackingDashboardService');
const { asyncHandler } = require('../utils/errorHandler');

// Stats fields that reveal money — hidden from viewers/staff who lack the
// sales/earnings permission, even though the rest of the dashboard is
// visible to everyone with `view`.
const EARNINGS_FIELDS = [
  'totalEstimatedInventoryValue', 'unsoldInventoryValue', 'soldInventoryValue',
  'totalSalesValue', 'totalProfit', 'averageSellingPrice', 'highestSale', 'lowestSale',
  'pendingPayments', 'dailyEarnings', 'weeklyEarnings', 'monthlyEarnings',
];

function redactStats(stats, permissions) {
  if (permissions.earnings && permissions.sales) return stats;
  const redacted = { ...stats };
  for (const field of EARNINGS_FIELDS) delete redacted[field];
  return redacted;
}

const trackingDashboardController = {
  getStats: asyncHandler(async (req, res) => {
    const stats = await trackingDashboardService.getStats();
    return res.status(200).json({ success: true, data: redactStats(stats, req.trackingMember.permissions) });
  }),

  getCharts: asyncHandler(async (req, res) => {
    const months = req.query.months ? parseInt(req.query.months, 10) : 12;
    const charts = await trackingDashboardService.getCharts(months);
    if (!req.trackingMember.permissions.earnings && !req.trackingMember.permissions.sales) {
      charts.sales = charts.sales.map(({ month, count }) => ({ month, count }));
    }
    return res.status(200).json({ success: true, data: charts });
  }),

  getRecent: asyncHandler(async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
    const recent = await trackingDashboardService.getRecent(limit);
    if (!req.trackingMember.permissions.sales) {
      recent.recentSales = recent.recentSales.map((s) => ({ ...s, sale_price: undefined, buyer_name: undefined }));
    }
    return res.status(200).json({ success: true, data: recent });
  }),

  getAlerts: asyncHandler(async (req, res) => {
    const alerts = await trackingDashboardService.getAlerts();
    if (!req.trackingMember.permissions.sales) {
      alerts.paymentsPending = alerts.paymentsPending.map((p) => ({ ...p, sale_price: undefined }));
    }
    return res.status(200).json({ success: true, data: alerts });
  }),
};

module.exports = trackingDashboardController;

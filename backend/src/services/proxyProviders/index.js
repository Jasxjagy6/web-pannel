/**
 * Registry for rotating-proxy provider drivers.
 *
 * Maps vendor identifier → driver class instance. Used by:
 *   - proxyProviderService when CRUDing rows
 *   - proxyService.pickProxyForSession to mint sticky proxies on the fly
 *   - the Providers UI to enumerate vendors and prefill defaults
 */

const IPRoyalDriver = require('./iproyalDriver');
const SoaxDriver = require('./soaxDriver');
const ProxyEmpireDriver = require('./proxyEmpireDriver');
const SmartproxyDriver = require('./smartproxyDriver');
const CustomEndpointDriver = require('./customEndpointDriver');

const DRIVERS = [
  IPRoyalDriver,
  SoaxDriver,
  ProxyEmpireDriver,
  SmartproxyDriver,
  CustomEndpointDriver,
];

const _instances = new Map();
for (const Cls of DRIVERS) {
  _instances.set(Cls.vendor, new Cls());
}

function getDriver(vendor) {
  if (!vendor) return null;
  return _instances.get(String(vendor).toLowerCase()) || null;
}

function listVendors() {
  return DRIVERS.map((Cls) => ({
    vendor: Cls.vendor,
    label: vendorLabel(Cls.vendor),
    defaults: Cls.defaults(),
  }));
}

function vendorLabel(vendor) {
  switch (vendor) {
    case 'iproyal': return 'IPRoyal';
    case 'soax': return 'SOAX';
    case 'proxyempire': return 'ProxyEmpire';
    case 'smartproxy': return 'Smartproxy / Decodo';
    case 'custom': return 'Custom rotating endpoint';
    default: return vendor;
  }
}

module.exports = { getDriver, listVendors, vendorLabel, DRIVERS };

export default function StatCard({ label, value, icon: Icon, tone = 'default', suffix }) {
  const toneClass = {
    default: 'text-gray-100',
    green: 'text-green-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    blue: 'text-blue-400',
  }[tone] || 'text-gray-100';

  return (
    <div className="rounded-xl border border-white/5 bg-dark-800/50 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-gray-600" />}
      </div>
      <p className={`text-2xl font-bold mt-1.5 ${toneClass}`}>
        {value}{suffix && <span className="text-sm font-normal text-gray-500 ml-1">{suffix}</span>}
      </p>
    </div>
  );
}

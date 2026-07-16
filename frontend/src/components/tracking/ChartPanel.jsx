import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer,
} from 'recharts';

const chartTooltipStyle = {
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: '8px',
  padding: '8px 12px',
  color: '#f8fafc',
  fontSize: '13px',
};

const axisProps = { stroke: '#64748b', fontSize: 12 };

export default function ChartPanel({ title, data, type = 'line', dataKey, color = '#6366f1', valuePrefix = '' }) {
  return (
    <div className="rounded-xl border border-white/5 bg-dark-800/50 p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">{title}</h3>
      <div className="h-56">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">No data yet</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {type === 'bar' ? (
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="month" {...axisProps} />
                <YAxis {...axisProps} tickFormatter={(v) => `${valuePrefix}${v}`} />
                <RechartsTooltip contentStyle={chartTooltipStyle} formatter={(v) => `${valuePrefix}${v}`} />
                <Bar dataKey={dataKey} fill={color} radius={[4, 4, 0, 0]} />
              </BarChart>
            ) : (
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="month" {...axisProps} />
                <YAxis {...axisProps} tickFormatter={(v) => `${valuePrefix}${v}`} />
                <RechartsTooltip contentStyle={chartTooltipStyle} formatter={(v) => `${valuePrefix}${v}`} />
                <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

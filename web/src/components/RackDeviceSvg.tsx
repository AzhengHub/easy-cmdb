interface Props {
  kind: string
  units: number
  status?: string
}

function ledClass(status?: string) {
  if (status === 'offline') return 'offline'
  if (status === 'paused') return 'paused'
  if (status === 'stopped' || status === 'unknown' || !status) return 'idle'
  return ''
}

function ServerFaceplate({ units, status }: { units: number; status?: string }) {
  const twoU = units >= 2
  const height = twoU ? 80 : 40
  const bayCount = twoU ? 16 : 8
  const bayWidth = twoU ? 30 : 28
  const startX = twoU ? 26 : 28
  const y = twoU ? 13 : 8
  const bayHeight = twoU ? 54 : 24
  return (
    <svg className="rack-face" viewBox={`0 0 400 ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <rect className="face-body" x="1" y="1" width="398" height={height - 2} rx="2" />
      <rect className="face-edge" x="3" y="3" width="394" height={height - 6} rx="1" />
      <rect className="face-handle" x="6" y={twoU ? 12 : 7} width="7" height={twoU ? 56 : 26} rx="2" />
      <circle className="face-button" cx="21" cy={twoU ? 27 : 14} r={twoU ? 4 : 3} />
      <circle className={`face-led ${ledClass(status)}`} cx="21" cy={twoU ? 40 : 24} r="2" />
      <circle className="face-led" cx="21" cy={twoU ? 49 : 31} r="1.6" />

      {Array.from({ length: bayCount }, (_, index) => {
        const x = startX + index * (bayWidth + 3)
        return (
          <g key={index}>
            <rect className="face-bay" x={x} y={y} width={bayWidth} height={bayHeight} rx="1.5" />
            <rect className="face-bay-slot" x={x + 4} y={y + 4} width={bayWidth - 8} height={bayHeight - 8} rx="1" />
            <rect className="face-bay-handle" x={x + 7} y={y + bayHeight - 7} width={bayWidth - 14} height="3" rx="1" />
          </g>
        )
      })}

      <g className="face-vents">
        {Array.from({ length: twoU ? 8 : 5 }, (_, index) => (
          <rect key={index} x={twoU ? 286 : 276} y={twoU ? 12 + index * 7 : 7 + index * 5} width={twoU ? 38 : 32} height="3" rx="1" />
        ))}
      </g>
      <g className="face-psu">
        <rect x="332" y={twoU ? 12 : 7} width="58" height={twoU ? 25 : 11} rx="1.5" />
        <rect x="332" y={twoU ? 44 : 24} width="58" height={twoU ? 25 : 11} rx="1.5" />
        <circle cx="377" cy={twoU ? 24 : 12} r="1.4" />
        <circle cx="377" cy={twoU ? 56 : 29} r="1.4" />
      </g>
    </svg>
  )
}

function SwitchFaceplate({ status }: { status?: string }) {
  const ports = Array.from({ length: 24 }, (_, index) => index)
  return (
    <svg className="rack-face" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true">
      <rect className="face-body switch-body" x="1" y="1" width="398" height="38" rx="2" />
      <rect className="face-edge" x="3" y="3" width="394" height="34" rx="1" />
      <rect className="face-handle" x="6" y="7" width="6" height="26" rx="2" />
      <circle className="face-button" cx="22" cy="14" r="3" />
      <circle className={`face-led ${ledClass(status)}`} cx="22" cy="25" r="2" />
      <circle className="face-led" cx="22" cy="32" r="1.4" />

      <g className="face-ports">
        {ports.map(index => {
          const row = index < 12 ? 0 : 1
          const column = index % 12
          const x = 48 + column * 21
          const y = 7 + row * 15
          return (
            <g key={index}>
              <rect className="face-port" x={x} y={y} width="16" height="10" rx="1" />
              <rect className="face-port-inner" x={x + 2} y={y + 2} width="12" height="6" rx=".5" />
              <circle className={`face-led ${ledClass(status)}`} cx={x + 3} cy={y + 4} r="1" />
            </g>
          )
        })}
      </g>

      <g className="face-sfp">
        <rect x="312" y="7" width="26" height="10" rx="1" />
        <rect x="342" y="7" width="26" height="10" rx="1" />
        <rect x="312" y="23" width="26" height="10" rx="1" />
        <rect x="342" y="23" width="26" height="10" rx="1" />
        <rect className="face-sfp-inner" x="316" y="10" width="18" height="4" rx=".5" />
        <rect className="face-sfp-inner" x="346" y="10" width="18" height="4" rx=".5" />
        <rect className="face-sfp-inner" x="316" y="26" width="18" height="4" rx=".5" />
        <rect className="face-sfp-inner" x="346" y="26" width="18" height="4" rx=".5" />
      </g>
      <rect className="face-console" x="374" y="15" width="14" height="10" rx="1" />
    </svg>
  )
}

export function RackDeviceSvg({ kind, units, status }: Props) {
  return kind === 'switch'
    ? <SwitchFaceplate status={status} />
    : <ServerFaceplate units={units} status={status} />
}

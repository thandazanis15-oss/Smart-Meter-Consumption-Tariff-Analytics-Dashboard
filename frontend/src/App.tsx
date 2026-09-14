import { FormEvent, useEffect, useMemo, useState } from 'react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type MeterPoint = {
  timestamp: string
  hour: string
  day: string
  temperature_c: number
  consumption_kwh: number
  demand_kw: number
  tariff: 'peak' | 'off_peak'
  anomaly: boolean
  price_per_kwh: number
  estimated_cost: number
}

type DashboardTab = 'Overview' | 'Billing' | 'Alerts' | 'Reports'
type LoginRole = 'admin' | 'department'
type AuthUser = {
  username: string
  email: string
  role: 'admin' | 'user'
}

const getApiBase = () => {
  if (typeof window === 'undefined') return 'http://localhost:8000'

  const sameOrigin = `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ''}`
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8000'
  }

  return sameOrigin
}

const API_BASE = getApiBase()
const getWebSocketUrl = () => `${API_BASE.replace(/^http/, 'ws')}/ws/metrics`
const AUTH_STORAGE_KEY = 'smart-meter-auth-user'

const readStoredUser = (): AuthUser | null => {
  try {
    const savedUser = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (!savedUser) return null

    const parsed = JSON.parse(savedUser) as Partial<AuthUser>
    if (!parsed.username || !parsed.role) return null

    return {
      username: parsed.username,
      email: parsed.email || '',
      role: parsed.role === 'admin' ? 'admin' : 'user',
    }
  } catch {
    return null
  }
}

const writeStoredUser = (user: AuthUser | null) => {
  try {
    if (!user) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user))
  } catch {
    // Ignore storage limit and browser privacy issues gracefully.
  }
}

const NAV_ITEMS: DashboardTab[] = ['Overview', 'Billing', 'Alerts', 'Reports']

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value)
}

function buildSparklinePath(values: number[], width = 86, height = 28) {
  if (!values.length) return ''

  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1

  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width
      const y = height - ((value - min) / range) * (height - 6) - 3
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')
}

function App() {
  const [history, setHistory] = useState<MeterPoint[]>([])
  const [live, setLive] = useState<MeterPoint | null>(null)
  const [connected, setConnected] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [loginRole, setLoginRole] = useState<LoginRole>('admin')
  const [loginError, setLoginError] = useState('')
  const [credentials, setCredentials] = useState({ username: '', email: '', password: '' })
  const [registerPasswordConfirm, setRegisterPasswordConfirm] = useState('')
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [registeredUsers, setRegisteredUsers] = useState<AuthUser[]>([])
  const [noticeMessage, setNoticeMessage] = useState('')
  const [lastNotice, setLastNotice] = useState('')
  const [dateRange, setDateRange] = useState({ start: '', end: '' })
  const [filters, setFilters] = useState({ region: 'All regions', substation: 'All grids', account: 'All accounts' })
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<DashboardTab>('Overview')
  const [livePaused, setLivePaused] = useState(false)
  const [tariffVisible, setTariffVisible] = useState({ peak: true, offPeak: true })

  const fetchHistory = async (startDate?: string, endDate?: string) => {
    setLoading(true)
    const params = new URLSearchParams()
    if (startDate) params.set('start_date', startDate)
    if (endDate) params.set('end_date', endDate)

    try {
      const response = await fetch(`${API_BASE}/history${params.toString() ? `?${params.toString()}` : ''}`)
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }

      const text = await response.text()
      const data = text ? (JSON.parse(text) as MeterPoint[]) : []
      if (!Array.isArray(data)) {
        throw new Error('History payload was not an array.')
      }

      setHistory(data)
      if (data.length > 0) {
        setLive(data[data.length - 1])
      }
    } catch {
      setHistory([])
      setLive(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchHistory()

    let socket: WebSocket | null = null
    let reconnectTimer: number | undefined

    const connectSocket = () => {
      try {
        socket = new WebSocket(getWebSocketUrl())
      } catch {
        setConnected(false)
        return
      }

      socket.onopen = () => {
        setConnected(true)
      }

      socket.onclose = () => {
        setConnected(false)
        if (!reconnectTimer) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined
            connectSocket()
          }, 2500)
        }
      }

      socket.onerror = () => {
        setConnected(false)
      }

      socket.onmessage = (event) => {
        if (livePaused) return

        try {
          const payload = JSON.parse(event.data) as MeterPoint
          if (!payload || !payload.timestamp) return

          setLive(payload)
          setHistory((prev) => {
            const next = [...prev, payload].sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            )
            return next.slice(-72)
          })
        } catch {
          // Ignore malformed websocket payloads to keep the dashboard alive.
        }
      }
    }

    connectSocket()

    return () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [livePaused])

  const orderedHistory = useMemo(
    () => [...history].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [history],
  )

  const filteredHistory = useMemo(() => {
    if (!dateRange.start && !dateRange.end) {
      return orderedHistory
    }

    return orderedHistory.filter((point) => {
      const eventDate = new Date(point.timestamp)
      const afterStart = !dateRange.start || eventDate >= new Date(dateRange.start)
      const beforeEnd = !dateRange.end || eventDate <= new Date(`${dateRange.end}T23:59:59`)
      return afterStart && beforeEnd
    })
  }, [dateRange, orderedHistory])

  const buildReportSummary = (data: MeterPoint[]) => {
    const total = data.reduce((sum, point) => sum + point.consumption_kwh, 0)
    const peak = data.filter((point) => point.tariff === 'peak')
    const offPeak = data.filter((point) => point.tariff === 'off_peak')
    const peakConsumption = peak.reduce((sum, point) => sum + point.consumption_kwh, 0)
    const offPeakConsumption = offPeak.reduce((sum, point) => sum + point.consumption_kwh, 0)
    const peakCost = peak.reduce((sum, point) => sum + point.estimated_cost, 0)
    const offPeakCost = offPeak.reduce((sum, point) => sum + point.estimated_cost, 0)
    const totalCost = peakCost + offPeakCost
    const totalConsumptionCheck = peakConsumption + offPeakConsumption
    const costCheck = peakCost + offPeakCost
    const anomalies = data.filter((point) => point.anomaly).length
    const maxPoint = data.reduce<MeterPoint | null>((best, point) => {
      if (!best || point.consumption_kwh > best.consumption_kwh) return point
      return best
    }, null)
    const avgTemperature = data.length
      ? data.reduce((sum, point) => sum + point.temperature_c, 0) / data.length
      : 0
    const averageUnitRate = total > 0 ? totalCost / total : 0
    const peakShare = totalCost > 0 ? (peakCost / totalCost) * 100 : 0
    const offPeakShare = totalCost > 0 ? (offPeakCost / totalCost) * 100 : 0

    return {
      total,
      totalConsumptionCheck,
      peakConsumption,
      offPeakConsumption,
      avg: data.length ? total / data.length : 0,
      peakCost,
      offPeakCost,
      totalCost,
      costCheck,
      averageUnitRate,
      peakShare,
      offPeakShare,
      anomalies,
      anomalyRate: data.length ? (anomalies / data.length) * 100 : 0,
      maxPoint,
      maxDemand: data.reduce((max, point) => Math.max(max, point.demand_kw), 0),
      avgTemperature,
      healthScore: Math.max(82, 100 - Math.min(32, anomalies * 2.5)),
    }
  }

  const summary = useMemo(() => {
    const data = filteredHistory.length ? filteredHistory : orderedHistory
    return buildReportSummary(data)
  }, [filteredHistory, orderedHistory])

  const sourceData = filteredHistory.length ? filteredHistory : orderedHistory

  const chartData = sourceData.map((point) => ({
    ...point,
    label: point.hour,
  }))

  const sparklineSeries = useMemo(() => {
    const source = chartData.slice(-12)
    return source.length > 0 ? source.map((point) => point.consumption_kwh) : [0, 1, 2, 3]
  }, [chartData])

  const peakCostSeries = useMemo(() => {
    const source = chartData.slice(-12)
    return source.length > 0 ? source.map((point) => point.estimated_cost) : [0, 1, 2, 2.5]
  }, [chartData])

  const tariffSplit = useMemo(() => {
    const peak = chartData.filter((point) => point.tariff === 'peak').reduce((sum, point) => sum + point.estimated_cost, 0)
    const offPeak = chartData.filter((point) => point.tariff === 'off_peak').reduce((sum, point) => sum + point.estimated_cost, 0)
    return [
      { name: 'Peak', value: peak || 1, color: '#d72626' },
      { name: 'Off-peak', value: offPeak || 1, color: '#f59e0b' },
    ]
  }, [chartData])

  const alertLedger = useMemo(
    () => chartData.slice(-8).reverse().map((point) => ({
      time: point.hour,
      title: point.anomaly ? 'Temperature anomaly' : 'Load stabilization',
      detail: point.anomaly ? `${point.temperature_c.toFixed(1)}°C deviation across node` : `${point.demand_kw.toFixed(1)} kW active draw`,
      severity: point.anomaly ? 'critical' : 'info',
    })),
    [chartData],
  )

  const anomalyRows = chartData.filter((point) => point.anomaly).slice(0, 5)

  const recentEvents = chartData.slice(-6).map((point) => ({
    title: point.anomaly ? 'Anomaly detected' : 'Normal load cycle',
    time: point.hour,
    detail: point.anomaly ? `${point.consumption_kwh.toFixed(1)} kWh spike` : `${point.demand_kw.toFixed(1)} kW demand`,
  }))

  useEffect(() => {
    const storedUser = readStoredUser()
    if (storedUser) {
      setAuthUser(storedUser)
      setCredentials((current) => ({ ...current, username: storedUser.username, email: storedUser.email }))
      setIsAuthenticated(true)
    }
  }, [])

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault()

    const username = credentials.username.trim()
    const password = credentials.password

    if (!username || !password) {
      setLoginError('Please enter both username and password.')
      return
    }

    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role: loginRole }),
      })

      if (response.ok) {
        const payload = (await response.json()) as { user?: AuthUser }
        const finalUser: AuthUser = {
          username: payload.user?.username || username,
          email: payload.user?.email || '',
          role: payload.user?.role || 'user',
        }
        writeStoredUser(finalUser)
        setAuthUser(finalUser)
        setCredentials({ username: finalUser.username, email: finalUser.email, password: '' })
        setRegisterPasswordConfirm('')
        setLoginError('')
        setIsAuthenticated(true)
        return
      }

      const errorPayload = (await response.json().catch(() => ({ detail: 'Invalid credentials.' }))) as { detail?: string }
      setLoginError(errorPayload.detail || 'Invalid credentials. Please check your username and password.')
    } catch {
      setLoginError('Unable to reach the authentication service. Please try again.')
    }
  }

  const handleRegister = async (event: FormEvent) => {
    event.preventDefault()

    const username = credentials.username.trim()
    const email = credentials.email.trim()
    const password = credentials.password

    if (!username || !email || !password) {
      setLoginError('Please enter a username, email, and password to register.')
      return
    }

    if (!email.includes('@') || !email.includes('.')) {
      setLoginError('Please enter a valid email address.')
      return
    }

    if (password.length < 6) {
      setLoginError('Password must be at least 6 characters long.')
      return
    }

    if (password !== registerPasswordConfirm) {
      setLoginError('Passwords do not match.')
      return
    }

    try {
      const response = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      })

      const payload = (await response.json().catch(() => ({ detail: 'Registration failed.' }))) as { detail?: string; user?: AuthUser }
      if (!response.ok) {
        setLoginError(payload.detail || 'Unable to create your account.')
        return
      }

      const newUser: AuthUser = {
        username: payload.user?.username || username,
        email: payload.user?.email || email,
        role: payload.user?.role || 'user',
      }

      writeStoredUser(newUser)
      setAuthUser(newUser)
      setCredentials({ username: newUser.username, email: newUser.email, password: '' })
      setRegisterPasswordConfirm('')
      setLoginError('')
      setIsAuthenticated(true)
      setAuthMode('login')
    } catch {
      setLoginError('Unable to reach the authentication service. Please try again.')
    }
  }

  const handleApplyDateRange = () => {
    if (dateRange.start && dateRange.end && dateRange.start > dateRange.end) {
      setLoginError('Start date must be before end date.')
      return
    }

    setLoginError('')
    fetchHistory(dateRange.start || undefined, dateRange.end || undefined)
  }

  const handleResetRange = () => {
    setDateRange({ start: '', end: '' })
    setFilters({ region: 'All regions', substation: 'All grids', account: 'All accounts' })
    setLoginError('')
    fetchHistory()
  }

  const handleRefreshStream = () => {
    fetchHistory(dateRange.start || undefined, dateRange.end || undefined)
  }

  const loadRegisteredUsers = async () => {
    try {
      const response = await fetch(`${API_BASE}/admin/users`)
      if (!response.ok) {
        throw new Error('Failed to load users')
      }

      const data = (await response.json()) as Array<{ username: string; email: string; role: string }>
      setRegisteredUsers(
        data.map((user) => ({
          username: user.username,
          email: user.email,
          role: user.role === 'admin' ? 'admin' : 'user',
        })),
      )
    } catch {
      setRegisteredUsers([])
    }
  }

  const handleBroadcastNotice = async () => {
    const trimmed = noticeMessage.trim()
    if (!trimmed) {
      setLoginError('Please type a notice before broadcasting.')
      return
    }

    try {
      const response = await fetch(`${API_BASE}/admin/notice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      })

      if (!response.ok) {
        throw new Error('Notice failed to broadcast')
      }

      const payload = (await response.json()) as { message?: string }
      setLastNotice(payload.message || trimmed)
      setNoticeMessage('')
      setLoginError('')
    } catch {
      setLoginError('Unable to broadcast the notice right now.')
    }
  }

  useEffect(() => {
    if (authUser?.role === 'admin') {
      loadRegisteredUsers()
    }
  }, [authUser?.role])

  const exportReport = async (format: 'csv' | 'xlsx' | 'pdf' = 'csv') => {
    if (!sourceData.length) {
      setLoginError('No data available to export for the selected range.')
      return
    }

    const rows = sourceData.map((point) => ({
      timestamp: point.timestamp,
      hour: point.hour,
      day: point.day,
      temperature_c: point.temperature_c,
      consumption_kwh: point.consumption_kwh,
      demand_kw: point.demand_kw,
      tariff: point.tariff,
      anomaly: point.anomaly ? 'Yes' : 'No',
      price_per_kwh: point.price_per_kwh,
      estimated_cost: point.estimated_cost,
    }))

    const reportSummary = buildReportSummary(sourceData)
    const reportTotalConsumption = reportSummary.total
    const reportPeakCost = reportSummary.peakCost
    const reportOffPeakCost = reportSummary.offPeakCost
    const reportTotalCost = reportSummary.totalCost
    const reportAnomalies = reportSummary.anomalies
    const reportAverageUnitRate = reportSummary.averageUnitRate
    const reportPeakShare = reportSummary.peakShare

    if (format === 'xlsx') {
      const workbook = XLSX.utils.book_new()
      const worksheet = XLSX.utils.json_to_sheet(rows)
      const summarySheetData = [
        ['Smart Meter Report Summary'],
        [],
        ['Total consumption (kWh)', reportTotalConsumption.toFixed(1)],
        ['Peak billing', formatCurrency(reportPeakCost)],
        ['Off-peak billing', formatCurrency(reportOffPeakCost)],
        ['Total billed cost', formatCurrency(reportTotalCost)],
        ['Average unit rate', `${reportAverageUnitRate > 0 ? formatCurrency(reportAverageUnitRate) : '$0.00'} / kWh`],
        ['Peak share', `${reportPeakShare.toFixed(1)}%`],
        ['Anomaly alerts', reportAnomalies],
        ['Data points', rows.length],
      ]
      const summarySheet = XLSX.utils.aoa_to_sheet(summarySheetData)
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Smart Meter Report')
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary')
      XLSX.writeFile(workbook, 'smart-meter-report.xlsx')
      return
    }

    if (format === 'pdf') {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
      const pageWidth = doc.internal.pageSize.getWidth()
      const pageHeight = doc.internal.pageSize.getHeight()
      const dark = [15, 23, 42] as const
      const red = [215, 38, 38] as const
      const slate = [100, 116, 139] as const
      const panel = [248, 250, 252] as const

      const reportRange = `${dateRange.start || 'All data'} to ${dateRange.end || 'Now'}`

      doc.setFillColor(red[0], red[1], red[2])
      doc.rect(0, 0, pageWidth, 180, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(22)
      doc.text('SMART METER', 42, 64)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.text('Utility Control Room', 42, 86)

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(28)
      doc.text('Operations & Billing Report', 42, 126)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.text(`Generated: ${new Date().toLocaleString()}`, 42, 152)

      doc.setFillColor(255, 255, 255)
      doc.roundedRect(42, 208, 220, 112, 14, 14, 'F')
      doc.setTextColor(dark[0], dark[1], dark[2])
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.text('Report scope', 60, 234)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.text(`Range: ${reportRange}`, 60, 258)
      doc.text(`Data points: ${rows.length}`, 60, 276)
      doc.text(`Math: total bill = peak + off-peak = ${formatCurrency(reportPeakCost)} + ${formatCurrency(reportOffPeakCost)}`, 60, 294)
      doc.text(`Average unit rate: ${reportAverageUnitRate > 0 ? formatCurrency(reportAverageUnitRate) : '$0.00'} / kWh`, 60, 312)

      doc.setFillColor(255, 255, 255)
      doc.roundedRect(285, 208, 240, 112, 14, 14, 'F')
      doc.setTextColor(dark[0], dark[1], dark[2])
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.text('Prepared by', 304, 234)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.text('Smart Meter Operations Suite', 304, 258)
      doc.text('Network Services Division', 304, 276)
      doc.text('Confidential operational report', 304, 294)

      doc.setFillColor(15, 23, 42)
      doc.roundedRect(42, 352, 198, 42, 12, 12, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.text('Total consumption', 58, 374)
      doc.setFontSize(18)
      doc.text(`${reportTotalConsumption.toFixed(1)} kWh`, 58, 390)

      doc.setFillColor(15, 23, 42)
      doc.roundedRect(255, 352, 146, 42, 12, 12, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.text('Total cost', 270, 374)
      doc.setFontSize(18)
      doc.text(formatCurrency(reportTotalCost), 270, 390)

      doc.setFillColor(15, 23, 42)
      doc.roundedRect(415, 352, 130, 42, 12, 12, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.text('Alerts', 430, 374)
      doc.setFontSize(18)
      doc.text(String(reportAnomalies), 430, 390)

      doc.addPage()

      doc.setFillColor(panel[0], panel[1], panel[2])
      doc.rect(0, 0, pageWidth, pageHeight, 'F')
      doc.setTextColor(dark[0], dark[1], dark[2])
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(18)
      doc.text('Executive summary', 42, 52)
      doc.setDrawColor(red[0], red[1], red[2])
      doc.line(42, 62, 200, 62)

      const summaryCards = [
        { label: 'Total consumption', value: `${reportTotalConsumption.toFixed(1)} kWh` },
        { label: 'Peak demand', value: `${sourceData.reduce((max, point) => Math.max(max, point.demand_kw), 0).toFixed(1)} kW` },
        { label: 'Peak billing', value: formatCurrency(reportPeakCost) },
        { label: 'Off-peak billing', value: formatCurrency(reportOffPeakCost) },
        { label: 'Average unit rate', value: `${reportAverageUnitRate > 0 ? formatCurrency(reportAverageUnitRate) : '$0.00'} / kWh` },
        { label: 'Peak share', value: `${reportPeakShare.toFixed(1)}%` },
      ]

      summaryCards.forEach((card, index) => {
        const x = index % 2 === 0 ? 42 : 310
        const y = 88 + Math.floor(index / 2) * 82
        doc.setFillColor(255, 255, 255)
        doc.roundedRect(x, y, 220, 64, 12, 12, 'F')
        doc.setDrawColor(226, 232, 240)
        doc.roundedRect(x, y, 220, 64, 12, 12, 'S')
        doc.setTextColor(slate[0], slate[1], slate[2])
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(10)
        doc.text(card.label, x + 18, y + 24)
        doc.setTextColor(dark[0], dark[1], dark[2])
        doc.setFontSize(18)
        doc.text(card.value, x + 18, y + 46)
      })

      autoTable(doc, {
        startY: 270,
        head: [['Date', 'Hour', 'Tariff', 'Consumption (kWh)', 'Demand (kW)', 'Cost']],
        body: [
          ...rows.slice(-12).map((row) => [
            row.timestamp,
            row.hour,
            row.tariff,
            row.consumption_kwh.toFixed(1),
            row.demand_kw.toFixed(1),
            formatCurrency(row.estimated_cost),
          ]),
          ['', 'TOTAL', '', reportTotalConsumption.toFixed(1), '', formatCurrency(reportTotalCost)],
        ],
        styles: { fontSize: 8, cellPadding: 6 },
        headStyles: { fillColor: [red[0], red[1], red[2]], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [244, 247, 250] },
        margin: { left: 42, right: 42 },
        tableWidth: pageWidth - 84,
      })

      const pageCount = doc.getNumberOfPages()
      for (let pageIndex = 1; pageIndex <= pageCount; pageIndex += 1) {
        doc.setPage(pageIndex)
        doc.setDrawColor(203, 213, 225)
        doc.line(42, pageHeight - 36, pageWidth - 42, pageHeight - 36)
        doc.setTextColor(slate[0], slate[1], slate[2])
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8)
        doc.text('Smart Meter Operations Suite', 42, pageHeight - 20)
        doc.text('Confidential utility report', pageWidth - 190, pageHeight - 20)
        doc.text(`Page ${pageIndex} of ${pageCount}`, pageWidth - 72, pageHeight - 20)
      }

      doc.save('smart-meter-report.pdf')
      return
    }

    const params = new URLSearchParams()
    if (dateRange.start) params.set('start_date', dateRange.start)
    if (dateRange.end) params.set('end_date', dateRange.end)

    const url = `${API_BASE}/report/export${params.toString() ? `?${params.toString()}` : ''}`
    const response = await fetch(url)
    const csv = await response.text()
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'smart-meter-billing-report.csv'
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const renderOverview = () => (
    <>
      <section className="stats-grid">
        <div className="metric-card">
          <div className="metric-topline">
            <span>Total consumption</span>
            <span className="tag tag-success">+4.8%</span>
          </div>
          <strong>{summary.total.toFixed(1)} kWh</strong>
          <small>Across selected window</small>
          <svg className="sparkline" viewBox="0 0 86 28" preserveAspectRatio="none" aria-hidden="true">
            <path d={buildSparklinePath(sparklineSeries)} />
          </svg>
        </div>
        <div className="metric-card">
          <div className="metric-topline">
            <span>Peak demand</span>
            <span className="tag tag-warning">High</span>
          </div>
          <strong>{summary.maxDemand.toFixed(1)} kW</strong>
          <small>Highest system load</small>
          <svg className="sparkline" viewBox="0 0 86 28" preserveAspectRatio="none" aria-hidden="true">
            <path d={buildSparklinePath(chartData.slice(-12).map((point) => point.demand_kw))} />
          </svg>
        </div>
        <div className="metric-card">
          <div className="metric-topline">
            <span>Peak billing</span>
            <span className="tag tag-info">Rate $0.27</span>
          </div>
          <strong>{formatCurrency(summary.peakCost)}</strong>
          <small>Morning/evening peak</small>
          <svg className="sparkline" viewBox="0 0 86 28" preserveAspectRatio="none" aria-hidden="true">
            <path d={buildSparklinePath(peakCostSeries)} />
          </svg>
        </div>
        <div className="metric-card">
          <div className="metric-topline">
            <span>Off-peak billing</span>
            <span className="tag tag-neutral">Rate $0.18</span>
          </div>
          <strong>{formatCurrency(summary.offPeakCost)}</strong>
          <small>Night/day baseline</small>
          <svg className="sparkline" viewBox="0 0 86 28" preserveAspectRatio="none" aria-hidden="true">
            <path d={buildSparklinePath(chartData.slice(-12).map((point) => point.estimated_cost))} />
          </svg>
        </div>
        <div className="metric-card">
          <div className="metric-topline">
            <span>Avg temp</span>
            <span className="tag tag-neutral">Stable</span>
          </div>
          <strong>{summary.avgTemperature.toFixed(1)}°C</strong>
          <small>Weather impacted load</small>
          <svg className="sparkline" viewBox="0 0 86 28" preserveAspectRatio="none" aria-hidden="true">
            <path d={buildSparklinePath(chartData.slice(-12).map((point) => point.temperature_c))} />
          </svg>
        </div>
        <div className="metric-card">
          <div className="metric-topline">
            <span>Health score</span>
            <span className="tag tag-success">{summary.healthScore.toFixed(0)}%</span>
          </div>
          <strong>{summary.anomalies}</strong>
          <small>Deviation alerts</small>
          <svg className="sparkline" viewBox="0 0 86 28" preserveAspectRatio="none" aria-hidden="true">
            <path d={buildSparklinePath(chartData.slice(-12).map((point) => (point.anomaly ? 10 : 4)))} />
          </svg>
        </div>
      </section>

      <section className="alert-ledger-block">
        <div className="panel-header ledger-header">
          <div>
            <span className="panel-label">Signal log</span>
            <h3>Alert ledger</h3>
          </div>
        </div>
        <div className="alert-ledger">
          {alertLedger.map((entry) => (
            <div key={`${entry.time}-${entry.title}`} className={`ledger-row ${entry.severity}`}>
              <span className="ledger-time">{entry.time}</span>
              <strong>{entry.title}</strong>
              <small>{entry.detail}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="chart-grid">
        <div className="panel-card wide-card">
          <div className="panel-header">
            <div>
              <span className="panel-label">Load profile</span>
              <h3>Demand trend</h3>
            </div>
            <span className="panel-tag">{live ? `Latest: ${live.hour}` : 'Awaiting data'}</span>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="consumeFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="#79d7ff" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#79d7ff" stopOpacity={0.08} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#274363" />
              <XAxis dataKey="label" stroke="#cbd5e1" />
              <YAxis stroke="#cbd5e1" />
              <Tooltip />
              <Area type="monotone" dataKey="consumption_kwh" stroke="#79d7ff" fill="url(#consumeFill)" strokeWidth={2.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="panel-card slim-card tariff-panel">
          <div className="panel-header">
            <div>
              <span className="panel-label">Cost view</span>
              <h3>Tariff split</h3>
            </div>
          </div>

          <div className="tariff-chart-wrap">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={tariffSplit.filter((segment) => tariffVisible[segment.name === 'Peak' ? 'peak' : 'offPeak'])}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={42}
                  outerRadius={72}
                  paddingAngle={3}
                  stroke="rgba(15,23,42,0.8)"
                  strokeWidth={2}
                >
                  {tariffSplit.map((segment) => (
                    <Cell
                      key={segment.name}
                      fill={segment.color}
                      opacity={tariffVisible[segment.name === 'Peak' ? 'peak' : 'offPeak'] ? 1 : 0.25}
                    />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>

            <div className="tariff-legend">
              {tariffSplit.map((segment) => (
                <button
                  key={segment.name}
                  type="button"
                  className={`legend-toggle ${tariffVisible[segment.name === 'Peak' ? 'peak' : 'offPeak'] ? 'active' : ''}`}
                  onClick={() => {
                    const key = segment.name === 'Peak' ? 'peak' : 'offPeak'
                    setTariffVisible((current) => ({ ...current, [key]: !current[key] }))
                  }}
                >
                  <span className="legend-dot" style={{ backgroundColor: segment.color }} />
                  {segment.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="chart-grid lower-grid">
        <div className="panel-card wide-card">
          <div className="panel-header">
            <div>
              <span className="panel-label">System interplay</span>
              <h3>Temperature vs load</h3>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#274363" />
              <XAxis dataKey="label" stroke="#cbd5e1" />
              <YAxis stroke="#cbd5e1" />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="temperature_c" stroke="#f7b267" strokeWidth={2} name="Temperature °C" />
              <Line type="monotone" dataKey="demand_kw" stroke="#a78bfa" strokeWidth={2} name="Demand kW" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="panel-card slim-card">
          <div className="panel-header">
            <div>
              <span className="panel-label">Operations</span>
              <h3>Recent events</h3>
            </div>
          </div>
          <div className="event-list">
            {recentEvents.map((event) => (
              <div key={`${event.time}-${event.title}`} className="event-item">
                <div className={`pulse ${event.title.includes('Anomaly') ? 'danger' : 'ok'}`} />
                <div>
                  <strong>{event.title}</strong>
                  <small>{event.detail}</small>
                </div>
                <span>{event.time}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  )

  const renderBilling = () => (
    <section className="panel-card full-width-panel">
      <div className="panel-header">
        <div>
          <span className="panel-label">Finance</span>
          <h3>Billing summary</h3>
        </div>
      </div>
      <div className="billing-grid">
        <div className="insight-box primary-box">
          <span>Total billable energy</span>
          <strong>{summary.total.toFixed(1)} kWh</strong>
          <small>Calculated across all filtered periods</small>
        </div>
        <div className="insight-box">
          <span>Peak period cost</span>
          <strong>{formatCurrency(summary.peakCost)}</strong>
          <small>Morning/evening premium rate</small>
        </div>
        <div className="insight-box">
          <span>Off-peak cost</span>
          <strong>{formatCurrency(summary.offPeakCost)}</strong>
          <small>Lower baseline electricity rate</small>
        </div>
        <div className="insight-box">
          <span>Projected total</span>
          <strong>{formatCurrency(summary.totalCost)}</strong>
          <small>Expected customer billing total</small>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Hour</th>
              <th>Tariff</th>
              <th>Load</th>
              <th>Cost</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {chartData.slice(-8).map((point) => (
              <tr key={`${point.timestamp}-${point.hour}`}>
                <td>{point.hour}</td>
                <td>{point.tariff === 'peak' ? 'Peak' : 'Off-peak'}</td>
                <td>{point.consumption_kwh.toFixed(1)} kWh</td>
                <td>{formatCurrency(point.estimated_cost)}</td>
                <td>{point.anomaly ? 'Alert' : 'Stable'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )

  const renderAlerts = () => (
    <section className="panel-card full-width-panel">
      <div className="panel-header">
        <div>
          <span className="panel-label">Monitoring</span>
          <h3>Anomaly detection</h3>
        </div>
      </div>
      <div className="alert-summary-row">
        <div className="alert-box danger-box">
          <span>Deviation rate</span>
          <strong>{summary.anomalyRate.toFixed(1)}%</strong>
        </div>
        <div className="alert-box warn-box">
          <span>Peak anomaly points</span>
          <strong>{summary.anomalies}</strong>
        </div>
        <div className="alert-box ok-box">
          <span>System status</span>
          <strong>{connected ? 'Online' : 'Unstable'}</strong>
        </div>
      </div>
      <div className="alert-list">
        {anomalyRows.length ? anomalyRows.map((point) => (
          <div key={`${point.timestamp}-alert`} className="alert-row">
            <div>
              <strong>{point.hour}</strong>
              <small>{point.day}</small>
            </div>
            <div>
              <span>Consumption</span>
              <strong>{point.consumption_kwh.toFixed(1)} kWh</strong>
            </div>
            <div>
              <span>Demand</span>
              <strong>{point.demand_kw.toFixed(1)} kW</strong>
            </div>
            <div>
              <span>Tariff</span>
              <strong>{point.tariff}</strong>
            </div>
          </div>
        )) : <div className="empty-state">No anomalies in the selected date range.</div>}
      </div>
    </section>
  )

  const renderReports = () => (
    <section className="panel-card full-width-panel">
      <div className="panel-header">
        <div>
          <span className="panel-label">Reports</span>
          <h3>Operational snapshot</h3>
        </div>
        <div className="action-group">
          <button className="secondary-button" type="button" onClick={() => exportReport('csv')}>CSV</button>
          <button className="secondary-button" type="button" onClick={() => exportReport('xlsx')}>Excel</button>
          <button className="primary-button" type="button" onClick={() => exportReport('pdf')}>PDF</button>
        </div>
      </div>
      <div className="report-cards">
        <div className="report-card">
          <span>Current range</span>
          <strong>{dateRange.start || 'All data'} → {dateRange.end || 'Now'}</strong>
        </div>
        <div className="report-card">
          <span>Total energy</span>
          <strong>{summary.total.toFixed(1)} kWh</strong>
        </div>
        <div className="report-card">
          <span>Peak energy</span>
          <strong>{summary.peakConsumption.toFixed(1)} kWh</strong>
        </div>
        <div className="report-card">
          <span>Off-peak energy</span>
          <strong>{summary.offPeakConsumption.toFixed(1)} kWh</strong>
        </div>
        <div className="report-card">
          <span>Peak cost</span>
          <strong>{formatCurrency(summary.peakCost)}</strong>
        </div>
        <div className="report-card">
          <span>Off-peak cost</span>
          <strong>{formatCurrency(summary.offPeakCost)}</strong>
        </div>
        <div className="report-card">
          <span>Total billed</span>
          <strong>{formatCurrency(summary.totalCost)}</strong>
        </div>
        <div className="report-card">
          <span>Average unit rate</span>
          <strong>{summary.averageUnitRate > 0 ? formatCurrency(summary.averageUnitRate) : '$0.00'} / kWh</strong>
        </div>
      </div>
      <div className="report-callout">
        <strong>Formula check:</strong> total energy = peak energy + off-peak energy = {summary.peakConsumption.toFixed(1)} + {summary.offPeakConsumption.toFixed(1)} = {summary.total.toFixed(1)} kWh.<br />
        <strong>Billing check:</strong> total billed = peak cost + off-peak cost = {formatCurrency(summary.peakCost)} + {formatCurrency(summary.offPeakCost)} = {formatCurrency(summary.totalCost)}.
      </div>
    </section>
  )

  return (
    <div className="app-shell">
      {!isAuthenticated ? (
        <div className="login-shell">
          <div className="login-layout single-panel-layout">
            <section className="card login-panel login-panel-clean">
              <div className="brand-lockup brand-lockup-centered">
                <div className="brand-mark">SM</div>
                <div>
                  <div className="brand-title">Smart Meter</div>
                  <div className="brand-caption">Utility control</div>
                </div>
              </div>

              <div className="login-heading">
                <p className="eyebrow">Secure access</p>
                <h2>{authMode === 'login' ? 'Sign in' : 'Create account'}</h2>
              </div>

              {authMode === 'login' && (
                <div className="auth-toggle" aria-label="Login as role">
                  <button
                    type="button"
                    className={loginRole === 'admin' ? 'active' : ''}
                    onClick={() => {
                      setLoginRole('admin')
                      setLoginError('')
                    }}
                  >
                    Admin
                  </button>
                  <button
                    type="button"
                    className={loginRole === 'department' ? 'active' : ''}
                    onClick={() => {
                      setLoginRole('department')
                      setLoginError('')
                    }}
                  >
                    Department member
                  </button>
                </div>
              )}

              <div className="auth-toggle" aria-label="Authentication mode">
                <button
                  type="button"
                  className={authMode === 'login' ? 'active' : ''}
                  onClick={() => {
                    setAuthMode('login')
                    setLoginError('')
                  }}
                >
                  Login
                </button>
                <button
                  type="button"
                  className={authMode === 'register' ? 'active' : ''}
                  onClick={() => {
                    setAuthMode('register')
                    setLoginError('')
                  }}
                >
                  Register
                </button>
              </div>

              <form className="login-form" onSubmit={authMode === 'login' ? handleLogin : handleRegister}>
                <label>
                  Username
                  <input
                    value={credentials.username}
                    onChange={(event) => setCredentials({ ...credentials, username: event.target.value })}
                    placeholder="Enter username"
                  />
                </label>
                {authMode === 'register' && (
                  <label>
                    Email
                    <input
                      type="email"
                      value={credentials.email}
                      onChange={(event) => setCredentials({ ...credentials, email: event.target.value })}
                      placeholder="Enter your email"
                    />
                  </label>
                )}
                <label>
                  Password
                  <input
                    type="password"
                    value={credentials.password}
                    onChange={(event) => setCredentials({ ...credentials, password: event.target.value })}
                    placeholder="Enter password"
                  />
                </label>
                {authMode === 'register' && (
                  <label>
                    Confirm password
                    <input
                      type="password"
                      value={registerPasswordConfirm}
                      onChange={(event) => setRegisterPasswordConfirm(event.target.value)}
                      placeholder="Confirm password"
                    />
                  </label>
                )}
                <button type="submit">{authMode === 'login' ? 'Sign in' : 'Create account'}</button>
              </form>
              {loginError && <p className="error-text">{loginError}</p>}
            </section>
          </div>
        </div>
      ) : (
        <div className="dashboard-shell">
          <aside className="sidebar">
            <div className="brand-block">
              <div className="brand-mark">SM</div>
              <div>
                <div className="brand-title">Smart Meter</div>
                <div className="brand-caption">Operations Suite</div>
              </div>
            </div>

            <nav className="nav-list">
              {NAV_ITEMS.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={`nav-button ${activeTab === item ? 'active' : ''}`}
                  onClick={() => setActiveTab(item)}
                >
                  {item}
                </button>
              ))}
            </nav>

<div className="sidebar-card">
              <span>System health</span>
              <strong>{summary.healthScore.toFixed(0)}%</strong>
              <small>{connected ? 'Telemetry linked' : 'Monitoring issue'}</small>
            </div>

            {authUser?.role === 'admin' && (
              <div className="sidebar-card admin-panel">
                <span>Admin controls</span>
                <strong>Access granted</strong>
                <small>Broadcast notices and review the current registered users.</small>
                <div className="admin-controls-stack">
                  <input
                    type="text"
                    value={noticeMessage}
                    onChange={(event) => setNoticeMessage(event.target.value)}
                    placeholder="Type a system notice"
                    className="admin-notice-input"
                  />
                  <button type="button" className="secondary-button admin-button" onClick={handleBroadcastNotice}>
                    Broadcast notice
                  </button>
                </div>
                <div className="admin-panel-list">
                  <strong className="admin-list-title">Registered users</strong>
                  {registeredUsers.length > 0 ? (
                    registeredUsers.slice(0, 6).map((user) => (
                      <div key={`${user.username}-${user.email}`} className="admin-user-row">
                        <span>{user.username}</span>
                        <small>{user.email}</small>
                      </div>
                    ))
                  ) : (
                    <small>No users loaded yet.</small>
                  )}
                </div>
                {lastNotice && <small className="admin-last-notice">Last notice: {lastNotice}</small>}
              </div>
            )}
          </aside>

          <main className="main-panel">
            <header className="topbar modern-topbar">
              <div>
                <p className="eyebrow">Utility grid analytics</p>
                <h2>{activeTab} dashboard</h2>
              </div>
              <div className="header-actions">
                <div className={`status-pill ${connected ? 'online' : 'offline'}`}>
                  {connected ? 'Live feed connected' : 'Offline'}
                </div>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setLivePaused((current) => !current)}
                  aria-label={livePaused ? 'Resume live feed' : 'Pause live feed'}
                >
                  {livePaused ? 'Resume' : 'Pause'}
                </button>
                <button className="icon-button" type="button" onClick={handleRefreshStream}>
                  Refresh
                </button>
                <div className="user-badge">
                  <div className="user-badge-meta">
                    <strong>{authUser?.username || 'User'}</strong>
                    <small>{authUser?.email || 'No email on record'}</small>
                  </div>
                  <span className="user-role-pill">{authUser?.role === 'admin' ? 'Admin' : 'User'}</span>
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => {
                    writeStoredUser(null)
                    setAuthUser(null)
                    setIsAuthenticated(false)
                    setAuthMode('login')
                    setCredentials({ username: '', email: '', password: '' })
                    setRegisterPasswordConfirm('')
                    setLoginError('')
                  }}
                >
                  Logout
                </button>
              </div>
            </header>

            <section className="toolbar-card">
              <div className="toolbar-header">
                <div>
                  <span className="panel-label">Control filters</span>
                  <h3>Operational window</h3>
                </div>
                <div className="action-group">
                  <button className="secondary-button" type="button" onClick={() => exportReport('csv')}>CSV</button>
                  <button className="secondary-button" type="button" onClick={() => exportReport('xlsx')}>Excel</button>
                  <button className="primary-button" type="button" onClick={() => exportReport('pdf')}>PDF</button>
                </div>
              </div>
              <div className="date-range-row">
                <label>
                  Start date
                  <input
                    type="date"
                    value={dateRange.start}
                    onChange={(event) => setDateRange((current) => ({ ...current, start: event.target.value }))}
                  />
                </label>
                <label>
                  End date
                  <input
                    type="date"
                    value={dateRange.end}
                    onChange={(event) => setDateRange((current) => ({ ...current, end: event.target.value }))}
                  />
                </label>
                <label>
                  Region node
                  <select
                    value={filters.region}
                    onChange={(event) => setFilters((current) => ({ ...current, region: event.target.value }))}
                  >
                    <option>All regions</option>
                    <option>North zone</option>
                    <option>Central grid</option>
                    <option>Coastal cluster</option>
                  </select>
                </label>
                <label>
                  Substation
                  <select
                    value={filters.substation}
                    onChange={(event) => setFilters((current) => ({ ...current, substation: event.target.value }))}
                  >
                    <option>All grids</option>
                    <option>Grid A-12</option>
                    <option>Grid B-04</option>
                    <option>Grid C-09</option>
                  </select>
                </label>
                <label>
                  Customer account
                  <select
                    value={filters.account}
                    onChange={(event) => setFilters((current) => ({ ...current, account: event.target.value }))}
                  >
                    <option>All accounts</option>
                    <option>Acct 2418</option>
                    <option>Acct 6903</option>
                    <option>Acct 8841</option>
                  </select>
                </label>
                <button type="button" className="secondary-button" onClick={handleApplyDateRange}>Apply range</button>
                <button type="button" className="ghost-button" onClick={handleResetRange}>Reset</button>
              </div>
              {loading && <p className="loading-text">Loading billing dataset...</p>}
              {loginError && <p className="error-text">{loginError}</p>}
            </section>

            {activeTab === 'Overview' && renderOverview()}
            {activeTab === 'Billing' && renderBilling()}
            {activeTab === 'Alerts' && renderAlerts()}
            {activeTab === 'Reports' && renderReports()}
          </main>
        </div>
      )}
    </div>
  )
}

export default App

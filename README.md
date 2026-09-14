# Smart Meter Consumption & Tariff Analytics Dashboard

A full-stack utility analytics dashboard built to monitor smart meter consumption, tariff behavior, billing estimates, and operational reporting. This project combines a Python FastAPI backend with a React + TypeScript frontend to simulate a realistic energy monitoring and billing system for portfolio presentation.

## Project Summary

This portfolio project focuses on the core workflow of a modern smart meter operations platform:

- live meter telemetry simulation
- time-of-use tariff classification
- energy consumption and demand monitoring
- cost estimation and billing summaries
- user registration and login
- admin-side user visibility and notice management
- CSV, Excel, and PDF reporting

The goal of the system is to demonstrate how a utility or energy management company could analyze usage patterns, estimate customer billing, and present operational data in a professional dashboard experience.

## Why This Project Matters

Smart meter analytics is a high-value domain in energy management, infrastructure monitoring, and utility optimization. This project highlights a strong combination of:

- data visualization
- backend API design
- user authentication
- operational reporting
- dashboard logic and business understanding

## Tech Stack

### Frontend
- React
- TypeScript
- Vite
- Recharts
- XLSX
- jsPDF
- jspdf-autotable

### Backend
- Python
- FastAPI
- Uvicorn
- JSON-based user persistence for local demo use

## Key Features

- live smart meter data simulation
- historical and filtered data analysis
- peak and off-peak tariff segmentation
- consumption, demand, and cost analytics
- billing summary cards and KPI breakdowns
- registration and login flow
- admin controls for notices and user listing
- downloadable CSV, Excel, and PDF reports
- professional dashboard styling for portfolio presentation

## Default Demo Admin

The project keeps the administrator credentials private and outside the public repository.

- Copy [backend/.env.example](backend/.env.example) to [backend/.env](backend/.env) and set your own local admin values.
- The real credentials are stored locally and are not published in the codebase.
- Public documentation does not expose the actual username or password.

## System Architecture

```text
Browser (React App)
    |
    v
Frontend Dashboard
    |
    +-- API Requests --> FastAPI Backend
                          |
                          +-- Meter data generation
                          +-- Auth and registration logic
                          +-- User storage (JSON demo store)
                          +-- Reporting and export endpoints
                          +-- WebSocket telemetry stream
```

## Project Structure

```text
Smart Meter Dashboard/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   └── users.json
│   ├── requirements.txt
│   └── .venv/
├── frontend/
│   ├── src/
│   ├── package.json
│   └── vite.config.*
├── .gitignore
├── README.md
├── project_logic_connection.pdf
└── .git/
```

## Screenshots

This section can be updated with project images when you are ready to showcase the app visually.

```text
[Add screenshot 1]
[Add screenshot 2]
[Add screenshot 3]
```

## Local Setup

### 1. Clone the repository

```bash
git clone <your-repository-url>
cd "Smart-Meter-Consumption-Tarrif-Analysis-Dashboard"
```

### 2. Set up the backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Use your own private values in [backend/.env](backend/.env) before running the app.

### 3. Set up the frontend

Open a second terminal and run:

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```

### 4. Open the application

Open this URL in the browser:

```text
http://localhost:5173/
```

## API Endpoints

The frontend communicates with the backend through the following routes:

- POST /auth/login
- POST /auth/register
- GET /history
- GET /report/export
- GET /admin/users
- POST /admin/notice
- WebSocket /ws/metrics

## Reporting Features

The reporting system supports:

- CSV export
- Excel export
- PDF export

The exported numbers are generated from the same filtered data used in the dashboard, ensuring consistency between the visual summary and the downloadable report.

## Project Impact

This project demonstrates the ability to:

- build a complete frontend-backend application
- model real-world utility data flows
- implement dashboard KPIs and analytics
- work with live telemetry simulation
- generate professional reports for stakeholder communication
- build a polished user-facing system for portfolio presentation

## Future Enhancements

This project is intentionally structured as a strong portfolio prototype. For real production use, it can be upgraded with:

- PostgreSQL or MySQL database
- JWT authentication
- role-based access control
- secure environment variables
- cloud deployment for frontend and backend
- logging, monitoring, and auditing
- enterprise-grade data security

## License

This project is intended for learning, portfolio presentation, and demonstration purposes.

## Author

Thandazani

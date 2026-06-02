import asyncio
import asyncpg
import json

BANK_ID = "853d68da-6535-4370-9f41-0c6e35604795"
DB_URL = "postgresql://los_admin:los_dev_pass@localhost:5432/los_form"

async def seed():
    conn = await asyncpg.connect(DB_URL)

    collected = json.dumps({
        "name": "Arjun Sharma",
        "phone": "9876543210",
        "age": "32",
        "designation": "Software Engineer",
        "employer": "TCS",
        "qualification": "B.Tech",
        "experience": "8 years",
        "existing_emi": "5000",
        "loan_purpose": "Home Renovation",
        "loan_amount": "500000",
        "whatsapp_number": "9876543210"
    })
    analysis = json.dumps({
        "summary": "Customer interested in 5L personal loan for home renovation. Stable TCS job.",
        "lead_quality": "high",
        "category": "Hot Lead",
        "sentiment": "positive"
    })

    call_id = await conn.fetchval("""
        INSERT INTO agent_calls (
            bank_id, batch_id, customer_name, phone, loan_type, loan_amount, language,
            status, interested, form_sent, category, collected_data, call_analysis,
            started_at, ended_at, call_duration
        ) VALUES (
            $1, 'TEST-BATCH-001', 'Arjun Sharma', '9876543210', 'Personal Loan', 500000, 'hindi',
            'Called - Interested', true, true, 'Hot Lead', $2::jsonb, $3::jsonb,
            NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '2 minutes', 180
        ) RETURNING id
    """, BANK_ID, collected, analysis)
    print(f"CALL_ID: {call_id}")

    field_sources = json.dumps({
        "name": "Voice Call", "phone": "Voice Call", "age": "Voice Call",
        "designation": "Voice Call", "employer": "Voice Call", "loan_amount": "Voice Call"
    })

    import uuid as _uuid
    loan_id = f"LN-TEST-{str(_uuid.uuid4())[:8].upper()}"
    app_id = await conn.fetchval("""
        INSERT INTO loan_applications (
            bank_id, agent_call_id, phone, full_name, customer_name, loan_id,
            status, field_sources, submitted_at, is_complete, current_step, highest_step,
            designation, employer_name, qualification, total_work_experience,
            monthly_emi_existing, purpose_of_loan, loan_amount_requested, employment_type
        ) VALUES (
            $1, $2, '9876543210', 'Arjun Sharma', 'Arjun Sharma', $4,
            'submitted', $3::jsonb, NOW(), true, 6, 6,
            'Software Engineer', 'TCS', 'B.Tech', '8 years',
            5000, 'Home Renovation', 500000, 'salaried'
        ) RETURNING id
    """, BANK_ID, call_id, field_sources, loan_id)
    print(f"LOAN_ID: {loan_id}")
    print(f"APP_ID: {app_id}")

    await conn.execute("UPDATE agent_calls SET application_id=$1 WHERE id=$2", app_id, call_id)
    print("Linked call → application")

    await conn.close()
    print("Done.")

asyncio.run(seed())

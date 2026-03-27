export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
        <div className="text-6xl mb-4">🏦</div>
        <h1 className="text-3xl font-bold text-gray-900 mb-4">
          Bank Loan Application
        </h1>
        <p className="text-gray-600 mb-6">
          You will receive a personalized link via WhatsApp to complete your loan application.
        </p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm text-blue-800">
            🔒 Your information is encrypted and secure
          </p>
        </div>
      </div>
    </div>
  )
}

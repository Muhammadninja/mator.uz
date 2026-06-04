# API Documentation

## Three New Endpoints

### 1. GET /api/products - Product Catalog with Pagination & Filtering

**Description**: Get products from the master catalog with pagination and filtering by car model.

**Endpoint**: `GET /api/products`

**Query Parameters**:
- `page` (optional, default: 1) - Page number for pagination
- `limit` (optional, default: 20) - Number of items per page
- `carModel` (optional) - Filter by car model name (case-insensitive)

**Example Request**:
```bash
curl "http://localhost:3000/api/products?page=1&limit=10&carModel=Cobalt"
```

**Response**:
```json
{
  "data": [
    {
      "id": 1,
      "gmNumber": "96535062",
      "title": "Фильтр масляный",
      "carModel": "Cobalt",
      "imageUrl": "https://...",
      "createdAt": "2026-06-04T10:00:00Z",
      "stocks": [
        {
          "id": 1,
          "priceUzs": "50000.00",
          "quantity": 5,
          "seller": {
            "id": 1,
            "storeName": "Auto Parts Store",
            "marketName": null
          }
        }
      ]
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 45,
    "pages": 5
  }
}
```

---

### 2. POST /api/ai/diagnose - AI Problem Diagnosis with Claude

**Description**: Diagnose a car problem using Claude AI and return suggested parts from the database.

**Endpoint**: `POST /api/ai/diagnose`

**Request Body**:
```json
{
  "problemDescription": "Машина не заводится, стартер щёлкает",
  "carMake": "Chevrolet",
  "carModel": "Cobalt"
}
```

**Example Request**:
```bash
curl -X POST http://localhost:3000/api/ai/diagnose \
  -H "Content-Type: application/json" \
  -d '{
    "problemDescription": "Машина не заводится, стартер щёлкает",
    "carMake": "Chevrolet",
    "carModel": "Cobalt"
  }'
```

**Response**:
```json
{
  "problem_analysis": "Диагноз: Возможна неисправность аккумулятора, стартера или генератора.\nРекомендуемые детали: аккумулятор, стартер, генератор, кабели\nОписание проблемы: Когда стартер только щёлкает при попытке запуска без проворачивания двигателя, это обычно указывает на низкое напряжение аккумулятора или слабый контакт в электрической цепи запуска.",
  "suggested_parts": [
    {
      "id": 5,
      "title": "Аккумулятор 60Ah",
      "carModel": "Cobalt",
      "gmNumber": "96535063",
      "stocks": [
        {
          "sellerId": 2,
          "sellerName": "Auto Parts Plus",
          "priceUzs": "450000.00",
          "quantity": 3,
          "phone": "+998991234567"
        }
      ]
    },
    {
      "id": 6,
      "title": "Стартер",
      "carModel": "Cobalt",
      "gmNumber": "96535064",
      "stocks": [
        {
          "sellerId": 1,
          "sellerName": "Auto Parts Store",
          "priceUzs": "320000.00",
          "quantity": 2,
          "phone": "+998997654321"
        }
      ]
    }
  ],
  "confidence": 0.85
}
```

---

### 3. CRUD /api/garage - User's Garage (Cars Management)

**Description**: Manage user's car collection. Supports GET, POST, PUT, DELETE operations.

**Authentication**: Currently uses `X-User-Id` header (in production, use JWT/OAuth)

#### GET /api/garage - Get All User's Cars

**Endpoint**: `GET /api/garage`

**Headers**:
```
X-User-Id: 1
```

**Example Request**:
```bash
curl http://localhost:3000/api/garage \
  -H "X-User-Id: 1"
```

**Response**:
```json
[
  {
    "id": 1,
    "userId": 1,
    "make": "Chevrolet",
    "model": "Cobalt",
    "year": 2015,
    "vin": "Z0T1P5M63K1234567",
    "createdAt": "2026-06-04T10:00:00Z"
  },
  {
    "id": 2,
    "userId": 1,
    "make": "Toyota",
    "model": "Camry",
    "year": 2018,
    "vin": "4T1BF1AK2CU123456",
    "createdAt": "2026-06-04T11:00:00Z"
  }
]
```

#### GET /api/garage/:id - Get Single Car

**Endpoint**: `GET /api/garage/:id`

**Headers**:
```
X-User-Id: 1
```

**Response**:
```json
{
  "id": 1,
  "userId": 1,
  "make": "Chevrolet",
  "model": "Cobalt",
  "year": 2015,
  "vin": "Z0T1P5M63K1234567",
  "createdAt": "2026-06-04T10:00:00Z"
}
```

#### POST /api/garage - Create New Car

**Endpoint**: `POST /api/garage`

**Headers**:
```
X-User-Id: 1
```

**Request Body**:
```json
{
  "make": "Chevrolet",
  "model": "Cobalt",
  "year": 2015,
  "vin": "Z0T1P5M63K1234567"
}
```

**Example Request**:
```bash
curl -X POST http://localhost:3000/api/garage \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{
    "make": "Chevrolet",
    "model": "Cobalt",
    "year": 2015,
    "vin": "Z0T1P5M63K1234567"
  }'
```

**Response**:
```json
{
  "id": 1,
  "userId": 1,
  "make": "Chevrolet",
  "model": "Cobalt",
  "year": 2015,
  "vin": "Z0T1P5M63K1234567",
  "createdAt": "2026-06-04T10:00:00Z"
}
```

#### POST /api/garage/:id - Update Car

**Endpoint**: `POST /api/garage/:id`

**Headers**:
```
X-User-Id: 1
```

**Request Body** (all fields optional):
```json
{
  "make": "Toyota",
  "model": "Camry",
  "year": 2020
}
```

#### DELETE /api/garage/:id - Delete Car

**Endpoint**: `DELETE /api/garage/:id`

**Headers**:
```
X-User-Id: 1
```

**Response**: 204 No Content

**Example Request**:
```bash
curl -X DELETE http://localhost:3000/api/garage/1 \
  -H "X-User-Id: 1"
```

---

## Database Schema

### User Model
- `id` - Primary key
- `tgId` - Telegram ID (unique)
- `firstName`, `lastName` - User name
- `phone` - Contact phone
- `createdAt` - Timestamp

### UserCar Model (Garage)
- `id` - Primary key
- `userId` - Foreign key to User
- `make` - Car brand (e.g., Chevrolet, Toyota)
- `model` - Car model (e.g., Cobalt, Camry)
- `year` - Production year
- `vin` - Vehicle Identification Number
- `createdAt` - Timestamp

### Product Model (Already existed)
- `id` - Primary key
- `gmNumber` - OEM/GM part number
- `title` - Part name
- `carModel` - Compatible car model
- `imageUrl` - Product image URL
- `createdAt` - Timestamp

---

## Setup Instructions

### Environment Variables
Ensure these are in your `.env` file:
```
ANTHROPIC_API_KEY=sk-ant-xxxxx  # For Claude AI integration
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...
```

### Running the Server
```bash
# Development mode with hot reload
npm run start:dev

# Production
npm run build
npm run start:prod
```

### Testing the Endpoints

#### 1. Test Products Endpoint
```bash
# Get first 10 products filtered by Cobalt
curl "http://localhost:3000/api/products?page=1&limit=10&carModel=Cobalt"
```

#### 2. Test AI Diagnosis
```bash
curl -X POST http://localhost:3000/api/ai/diagnose \
  -H "Content-Type: application/json" \
  -d '{
    "problemDescription": "Машина не заводится",
    "carModel": "Cobalt"
  }'
```

#### 3. Test Garage CRUD
```bash
# Create a car
curl -X POST http://localhost:3000/api/garage \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{"make":"Chevrolet","model":"Cobalt","year":2015}'

# Get all cars
curl http://localhost:3000/api/garage \
  -H "X-User-Id: 1"

# Delete a car
curl -X DELETE http://localhost:3000/api/garage/1 \
  -H "X-User-Id: 1"
```

---

## Notes

1. **Authentication**: The garage endpoints currently use `X-User-Id` header for demo purposes. In production, implement proper JWT/OAuth authentication.

2. **Claude AI**: The diagnose endpoint requires a valid `ANTHROPIC_API_KEY`. Set `AI_MOCK=true` in `.env` to use regex-based fallback parsing without API costs.

3. **Pagination**: Default page size is 20 items. Adjust `limit` parameter as needed.

4. **Filtering**: Car model filtering is case-insensitive and supports partial matches.

5. **Stock Status**: Only in-stock items (quantity > 0) are returned in search results.

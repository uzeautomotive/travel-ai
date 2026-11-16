FROM python:3.12-slim

WORKDIR /app

# Эхлээд зөвхөн сангуудын жагсаалтыг хуулж суулгана (дахин build хийхэд хурдан болно)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Програм ба ML загвар. .env-ийг зориуд хуулахгүй (нууц мэдээлэл image-д орохгүй)
COPY main.py demand_model.joblib ./

# Загварын зам анхдагчаар. Ажиллуулахдаа -e эсвэл --env-file-аар өөрчилж болно
ENV MODEL_PATH=demand_model.joblib

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

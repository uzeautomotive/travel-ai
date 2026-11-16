// Backend-ийн хаяг: хуудас аль хаягаар нээгдсэн, тэр л машины 8000 порт.
// localhost-оор нээвэл http://localhost:8000, 192.168.1.5-аар нээвэл http://192.168.1.5:8000 болно.
const API_URL = `http://${location.hostname}:8000`;

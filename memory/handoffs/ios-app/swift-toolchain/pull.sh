set -e
TOKEN=$(curl -sS --max-time 30 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/swift:pull" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -sS --max-time 60 -H "Authorization: Bearer $TOKEN" -H 'Accept: application/vnd.oci.image.manifest.v1+json' https://registry-1.docker.io/v2/library/swift/manifests/sha256:89dab413be2e9f37057ce118a0941cc045775239e874e6124958ff83e3b6d1ca > manifest.json
python3 -c 'import json;m=json.load(open("manifest.json"));[print(l["digest"],l["size"]) for l in m["layers"]]' > layers.txt
cat layers.txt
mkdir -p rootfs
while read d s; do
  f=${d#sha256:}.tgz
  curl -sSL --max-time 1200 -H "Authorization: Bearer $TOKEN" https://registry-1.docker.io/v2/library/swift/blobs/$d -o $f
  echo "downloaded $d $(stat -c %s $f)"
  tar -xzf $f -C rootfs --exclude='dev/*' 2>&1 | tail -3 || true
  echo "extracted $d"
done < layers.txt
echo DONE

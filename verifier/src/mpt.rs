//! Merkle-Patricia proof verification (Ethereum state and storage tries), as returned by
//! `eth_getProof`. A proof is the list of RLP-encoded nodes from the root towards the key.
use crate::keccak;
use rlp::Rlp;

#[derive(Debug, PartialEq)]
pub enum ProofError {
    BadNode(&'static str),
    HashMismatch { depth: usize },
    Incomplete,
}

fn nibbles(key: &[u8]) -> Vec<u8> {
    key.iter().flat_map(|b| [b >> 4, b & 0x0f]).collect()
}

/// Hex-prefix decoding: (path nibbles, is_leaf).
fn hex_prefix(enc: &[u8]) -> Result<(Vec<u8>, bool), ProofError> {
    let first = *enc.first().ok_or(ProofError::BadNode("empty path"))?;
    let flag = first >> 4;
    let is_leaf = flag >= 2;
    let odd = flag % 2 == 1;
    let mut out = vec![];
    if odd {
        out.push(first & 0x0f);
    }
    out.extend(nibbles(&enc[1..]));
    Ok((out, is_leaf))
}

enum Next<'a> {
    Hash([u8; 32]),
    Inline(Rlp<'a>),
    Empty,
}

fn child<'a>(r: &Rlp<'a>) -> Result<Next<'a>, ProofError> {
    if r.is_list() {
        return Ok(Next::Inline(r.clone()));
    }
    let d = r.data().map_err(|_| ProofError::BadNode("child"))?;
    match d.len() {
        0 => Ok(Next::Empty),
        32 => Ok(Next::Hash(d.try_into().unwrap())),
        _ => Err(ProofError::BadNode("child length")),
    }
}

/// Walk the proof from `root` along `keccak(key)` (already hashed by the caller as `path`).
/// Returns `Ok(Some(value))` when the key is present, `Ok(None)` when the proof shows it is
/// absent (an exclusion proof), and an error when the proof doesn't link up to `root`.
pub fn verify(root: [u8; 32], path: [u8; 32], proof: &[Vec<u8>]) -> Result<Option<Vec<u8>>, ProofError> {
    let key = nibbles(&path);
    let mut pos = 0usize;
    let mut idx = 0usize;
    let mut expected = root;
    // the node currently being read: from the proof list (checked by hash) or inline
    let mut inline: Option<Vec<u8>> = None;
    loop {
        let raw: Vec<u8> = match inline.take() {
            Some(b) => b,
            None => {
                let n = proof.get(idx).ok_or(ProofError::Incomplete)?;
                if keccak(n) != expected {
                    return Err(ProofError::HashMismatch { depth: idx });
                }
                idx += 1;
                n.clone()
            }
        };
        let node = Rlp::new(&raw);
        let items = node.item_count().map_err(|_| ProofError::BadNode("not a list"))?;
        let next = match items {
            17 => {
                if pos == key.len() {
                    let v = node.at(16).and_then(|v| v.data().map(|d| d.to_vec())).map_err(|_| ProofError::BadNode("branch value"))?;
                    return Ok((!v.is_empty()).then_some(v));
                }
                let c = node.at(key[pos] as usize).map_err(|_| ProofError::BadNode("branch child"))?;
                pos += 1;
                child(&c)?
            }
            2 => {
                let enc = node.at(0).and_then(|p| p.data().map(|d| d.to_vec())).map_err(|_| ProofError::BadNode("path"))?;
                let (p, is_leaf) = hex_prefix(&enc)?;
                let rest = &key[pos..];
                if is_leaf {
                    if rest == p.as_slice() {
                        let v = node.at(1).and_then(|v| v.data().map(|d| d.to_vec())).map_err(|_| ProofError::BadNode("leaf value"))?;
                        return Ok(Some(v));
                    }
                    return Ok(None); // a different leaf sits here: the key is absent
                }
                if rest.len() < p.len() || rest[..p.len()] != p[..] {
                    return Ok(None); // the path diverges: absent
                }
                pos += p.len();
                child(&node.at(1).map_err(|_| ProofError::BadNode("ext child"))?)?
            }
            _ => return Err(ProofError::BadNode("node arity")),
        };
        match next {
            Next::Empty => return Ok(None),
            Next::Hash(h) => expected = h,
            Next::Inline(r) => inline = Some(r.as_raw().to_vec()),
        }
    }
}

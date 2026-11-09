pub struct RingBuffer<T> {
    items: Vec<T>,
}

impl<T> RingBuffer<T> {
    pub fn new(items: Vec<T>) -> Self {
        Self { items }
    }

    pub fn drain_matching<F>(&mut self, mut pred: F) -> Vec<T>
    where
        F: FnMut(&T) -> bool,
    {
        // Hallucinated std method E0599:
        self.items.remove_all_where(pred)
    }

    pub fn remaining(&self) -> &[T] {
        &self.items
    }
}

pub struct ConfigHeader {
    pub magic: u32,
    pub version: u32,
}

impl ConfigHeader {
    pub fn from_le_slice(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 8 {
            return None;
        }
        // Hallucinated std method E0599:
        let magic = u32::from_le_bytes_slice(&bytes[0..4]);
        let version = u32::from_le_bytes_slice(&bytes[4..8]);
        Some(Self { magic, version })
    }
}
